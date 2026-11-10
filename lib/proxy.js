/**
 * 反向代理：HTTP 与 WebSocket。
 *
 * 只负责「把请求搬到后端、把响应搬回来」，不做路由决策（匹配在 lib/route.js），
 * 也不负责注册监听（在 index.js）。这样改转发细节时不会碰到插件生命周期。
 */
import http from 'node:http'
import { state, statKey, statOf, touchTraffic } from './status.js'
import { DEFAULT_SETTINGS } from './config.js'

export function bodyToBuffer(body) {
  if (body === undefined || body === null) return null
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (typeof body === 'object') {
    try {
      return Buffer.from(JSON.stringify(body), 'utf8')
    } catch {
      return null
    }
  }
  return null
}

/* ---------- 流式响应（SSE）相关常量 ----------
 * 有些面板的「实时日志 / 系统状态」是 SSE（text/event-stream），NapCat WebUI
 * 就是这一种：先只 setHeader，之后**只有真的产生一条日志时才 write**，
 * 也就是说两个事件之间可能安静几分钟。
 *
 * 这类响应跟普通请求完全是两码事：
 *   - 不能用「多久没响应就算超时」去掐它，否则日志页点了就 502，
 *     表现是「实时日志永远是空的」「系统信息全是 -」；
 *   - 长时间没有字节的流会被中间层（frp / nginx / 运营商网关）当成死连接切断，
 *     所以要定期往里塞 SSE 注释行（`:` 开头，客户端按规范忽略）当心跳；
 *   - nginx 默认会缓冲上游响应体，必须用 X-Accel-Buffering: no 关掉，
 *     否则浏览器要等到缓冲区满才收到第一个字节。
 */
const envMs = (k, def) => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : def
}
// 环境变量只为自检时把时间缩短用（test/e2e.mjs 会设），运行期不需要关心
const SSE_PING_MS = envMs('WEB_MOUNT_SSE_PING_MS', 15000)
const SSE_GRACE_MS = envMs('WEB_MOUNT_SSE_GRACE_MS', 3000)
const SSE_HINT_MS = envMs('WEB_MOUNT_SSE_HINT_MS', 30000)

const isSseType = ct => /\btext\/event-stream\b/i.test(String(ct || ''))

/* 同一路由 10 秒内只记一条，避免后端整体挂掉时刷屏 */
function warnOnce(route, msg) {
  const now = Date.now()
  const key = statKey(route)
  if (now - (state.errLogged.get(key) || 0) > 10000) {
    state.errLogged.set(key, now)
    logger.warn(msg)
  }
}

/* 去掉 Set-Cookie 里的 Domain 属性，让浏览器绑定到「当前访问的域名」。
 * 只删 Domain=... 这一项，其余属性（Path/HttpOnly/SameSite/Expires/Max-Age）
 * 原样保留 —— 它们影响安全性与有效期，不能动。
 * 也顺手去掉已过时的 P3P 之外的域前缀写法（如 ".127.0.0.1"）。
 */
export function stripCookieDomain(raw) {
  const s = String(raw)
  // 按分号切分，丢弃整个 Domain 项；注意 Expires 里的逗号/分号不受影响，
  // 因为它本身不含分号分隔符
  return s
    .split(';')
    .filter(p => !/^\s*domain\s*=/i.test(p))
    .join(';')
    .replace(/;\s*;/g, ';')
    .trim()
}

/* 把转发失败翻译成「下一步该查什么」。
 * 光有 err.message 没法判断责任方：socket hang up 可能是后端根本没在监听、
 * 也可能是后端进程重启、还可能是它主动踢掉了这条连接。
 */
function explainError(err, sent) {
  /* 注意顺序：先判「请求没发出去/没连上」。
   * Node 在连不上时抛的也是同一个 'socket hang up' —— 只是 request 阶段
   * （ECONNREFUSED + 无 socket）。这时照着「后端返回响应前关连接」去解释，
   * 会把人引到完全错误的方向。 */
  if (err.code === 'ECONNREFUSED') return '后端端口没有进程在监听 —— 服务没启动，或监听在别的地址'
  if (err.code === 'ENOTFOUND') return '解析不到该主机名'
  if (err.code === 'ETIMEDOUT') return '连接后端超时'
  if (err.code === 'EHOSTUNREACH') return '主机不可达'
  if (err.message === 'socket hang up') {
    if (!sent.connected) {
      return '连不上后端 —— 该端口没有进程在监听（或地址写错/被拦截），请求根本没发出去'
    }
    return (
      '后端在返回响应前就关闭了连接 —— 常见于后端正在重启、'
      + '或它对本请求没返回任何响应头就直接断链。'
      + `本次已发出 ${sent.head} 字节请求头${sent.body ? `、${sent.body} 字节请求体` : ''}`
    )
  }
  if (err.code === 'ECONNRESET') return '连接被后端重置'
  if (/^timeout after \d+ms$/.test(err.message)) {
    // 超时分两种：连不上（后端没在听）和连上了但迟迟不回。这两者排查方向完全相反，
    // 而 Node 给的 message 一模一样，只能靠「连接是否已建立」来区分。
    if (!sent.connected) {
      return '连不上后端 —— 该端口没有进程在监听，或被防火墙拦截；请求没发出去'
    }
    return (
      `后端已接受连接但 ${Math.round(sent.waitedMs / 1000)} 秒内没返回任何响应 —— `
      + '不是网络不通，是后端这个接口本身卡住了：多为后端内部死等锁或下游，'
      + '或该功能尚未就绪。按后端问题排查，必要时调大 proxyTimeout'
    )
  }
  return err.message
}

/* ---------- HTTP 反向代理 ---------- */
export function forwardHttp(req, res, proxyPath, route) {
  const st = statOf(route)
  st.count++
  touchTraffic()
  const startedAt = Date.now()

  const headers = { ...req.headers }
  const originHost = headers.host || ''
  // Host 默认保留客户端原值，不改写成 host:port。
  //
  // 改写过会同时踩三个坑，而且都很难查：
  //   1. 面板普遍有防 DNS rebinding 的 Host 白名单校验，看到 127.0.0.1:port
  //      才发现「这请求不是从我自己域名进来的」-> 403 或直接不收；
  //   2. 后端按 Host 生成 Set-Cookie 的 Domain 与绝对跳转地址，
  //      下发 Domain=127.0.0.1 的 cookie 浏览器一律拒收 -> 登录态存不住，
  //      表现为「页面能开，但每个接口都要重新鉴权 / 返回空数据」；
  //   3. 后端按 Host 拼 Origin 校验，与浏览器实际发的 Origin 对不上 -> CSRF 拒绝。
  // 想恢复旧行为可设 preserveHost:false（极少数只认后端 Host 的后端需要）。
  if (state.settings.preserveHost === false) {
    headers.host = `${route.host}:${route.port}`
  }

  const remote = req.socket?.remoteAddress || ''
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${remote}` : remote
  headers['x-forwarded-host'] = originHost
  headers['x-forwarded-proto'] = req.socket?.encrypted ? 'https' : 'http'
  headers['x-forwarded-prefix'] = route.matchPath

  // body 处理：
  //  - 若 body-parser 已消费请求流(req._body / readableEnded)，只能拿 req.body 重新序列化，
  //    否则 req.pipe() 拿到的是空流，POST/PUT 内容会丢。
  //  - 否则保持原样流式转发(文件上传等大 body 不占内存)。
  const declaredLen = Number(headers['content-length'] || 0)
  const isChunked = /\bchunked\b/i.test(String(headers['transfer-encoding'] || ''))
  const hadBody = declaredLen > 0 || isChunked
  const consumed = req.readableEnded === true || req._body === true

  let bodyData = null
  if (hadBody && consumed) {
    bodyData = bodyToBuffer(req.body)
    if (!bodyData) bodyData = Buffer.alloc(0)
    if (!headers['content-type'] && req.body && typeof req.body === 'object') {
      headers['content-type'] = 'application/json'
    }
    headers['content-length'] = String(bodyData.length)
    delete headers['transfer-encoding']
  }

  /* ---------- 流式（SSE）状态机 ---------- */
  const wantsSse = isSseType(req.headers.accept)
  let sseSelfHeaded = false // 首字节没按时来，由我们先发 SSE 响应头
  let pingTimer = null
  let graceTimer = null
  let hintTimer = null
  let lastDownAt = Date.now()

  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }
  const clearWaitTimers = () => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    if (hintTimer) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
  }
  const startPing = () => {
    if (pingTimer) return
    pingTimer = setInterval(
      () => {
        if (res.writableEnded || res.destroyed) return stopPing()
        // 上游刚发过数据就不用插心跳，别把带宽浪费在没用的注释上
        if (Date.now() - lastDownAt < SSE_PING_MS) return
        lastDownAt = Date.now()
        try {
          res.write(': ping\n\n')
        } catch {
          stopPing()
        }
      },
      Math.max(200, Math.min(5000, Math.floor(SSE_PING_MS / 2))),
    )
    if (typeof pingTimer.unref === 'function') pingTimer.unref()
  }

  const proxyReq = http.request(
    { host: route.host, port: route.port, path: proxyPath || '/', method: req.method, headers },
    pRes => {
      clearWaitTimers()
      st.lastStatus = pRes.statusCode || 0
      st.lastMs = Date.now() - startedAt
      st.lastAt = Date.now()

      // 响应头已经拿到，说明后端活着。之后按空闲时间掐断只会误杀长连接
      // （SSE、大文件下载、后端慢速吐数据），所以把 socket 超时清掉。
      try {
        proxyReq.setTimeout(0)
      } catch {
        /* socket 已销毁 */
      }

      if (state.settings.debug) {
        logger.mark(
          `[web-mount] ${req.method} ${req.url} -> ${route.host}:${route.port}${proxyPath} ${st.lastStatus} ${st.lastMs}ms`,
        )
      }

      /* 后端自己返回 5xx 时也要留痕。
       * 否则日志里只有「转发失败」（= 我们连不上），后端返回的 502/504 静默透传，
       * 用户看到浏览器报 502 完全无从判断是哪一层的问题 —— 而这恰恰是最常见的情形：
       * 面板本身挂着上游（比如 GsCore 再去连别的服务），上游挂了它就回 502。
       */
      if (st.lastStatus >= 500) {
        st.errors++
        warnOnce(
          route,
          `[web-mount] 后端返回 ${st.lastStatus} ${route.name || route.matchPath} -> `
            + `${route.host}:${route.port}${proxyPath}（这是后端自己返回的，不是转发失败）`,
        )
      }

      const resHeaders = { ...pRes.headers }
      delete resHeaders.connection
      delete resHeaders['keep-alive']

      /* Set-Cookie 的 Domain 必须清掉。
       * 后端（尤其直连 127.0.0.1 时）常下发 Domain=127.0.0.1 或它自己的内网名，
       * 而浏览器是在 frp-hat.com 这种外部域名下收这条响应的 ——
       * Domain 不是当前域名的后缀，**整条 cookie 被静默丢弃**。
       * 表现就是：能打开页面、但一刷新又回登录页，或者接口一直说没权限。
       * 去掉 Domain 后浏览器自动绑定到当前域名，是反向代理的标准做法。
       */
      if (resHeaders['set-cookie']) {
        const list = Array.isArray(resHeaders['set-cookie']) ? resHeaders['set-cookie'] : [resHeaders['set-cookie']]
        resHeaders['set-cookie'] = list.map(stripCookieDomain)
      }

      // 允许把该页面嵌进面板/状态页：去掉后端的防嵌套头
      if (state.settings.allowEmbed) {
        delete resHeaders['x-frame-options']
        const cspKey = Object.keys(resHeaders).find(k => k.toLowerCase() === 'content-security-policy')
        if (cspKey) {
          const cleaned = String(resHeaders[cspKey])
            .split(';')
            .map(x => x.trim())
            .filter(x => x && !/^frame-ancestors\b/i.test(x))
            .join('; ')
          if (cleaned) resHeaders[cspKey] = cleaned
          else delete resHeaders[cspKey]
        }
      }

      const streaming = isSseType(resHeaders['content-type']) || sseSelfHeaded
      if (streaming) {
        // nginx 默认缓冲上游响应体，SSE 会被攒着不放（浏览器一个字节都收不到）
        resHeaders['x-accel-buffering'] = 'no'
        if (!resHeaders['cache-control']) resHeaders['cache-control'] = 'no-cache, no-transform'
        pRes.on('data', () => {
          lastDownAt = Date.now()
        })
        pRes.on('end', stopPing)
        pRes.on('close', stopPing)
        startPing()
        // 这条日志是排查「实时日志/系统信息空白」的锚点：
        // 有它 = 请求确实到了后端且后端开始推；没它 = 请求根本没到（浏览器/中间层）
        logger.mark(
          `[web-mount] SSE 已接上 ${req.url}${sseSelfHeaded ? '（插件先发的响应头）' : ''}`
            + ` 后端首字节 ${Date.now() - startedAt}ms`,
        )
      }

      // sseSelfHeaded：响应头已经由我们按 SSE 发出去了，这里不能再写
      if (!sseSelfHeaded && !res.headersSent) res.writeHead(pRes.statusCode || 502, resHeaders)
      pRes.on('error', () => {
        stopPing()
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
      })
      pRes.pipe(res)
    },
  )

  // 超时保护：后端卡死时释放连接，避免请求一直挂着。
  // 注意区分两种超时：TCP 都没连上（connect 阶段）与连上了但迟迟不回。
  //
  // SSE 例外：这类接口「没有新事件」时本来就一个字节都不发，用 proxyTimeout
  // 去掐它等于把功能直接掐死（日志页打开 30 秒就 502，实时日志永远空白）。
  const timeout = Number(state.settings.proxyTimeout) || DEFAULT_SETTINGS.proxyTimeout
  let connected = false
  proxyReq.on('socket', s => {
    if (!s.connecting) connected = true
    else s.once('connect', () => (connected = true))
  })
  if (!wantsSse) {
    proxyReq.setTimeout(timeout, () => proxyReq.destroy(new Error(`timeout after ${timeout}ms`)))
  } else {
    // 30 秒还没有第一个字节时给一句人话，免得用户以为插件没在转发
    hintTimer = setTimeout(() => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      logger.mark(
        `[web-mount] ${route.name || route.matchPath} 的 SSE 请求 ${proxyPath} 已等待 `
          + `${Math.round(SSE_HINT_MS / 1000)} 秒仍无数据（这类接口只在有新事件时才推送，连接保持中）`,
      )
    }, SSE_HINT_MS)
    if (typeof hintTimer.unref === 'function') hintTimer.unref()

    // 首字节迟迟不来时，先把 200 + SSE 响应头发出去：
    // 事件源客户端只有拿到响应头才会进入「已连接」，也才收得到心跳；
    // 反过来，一直不吭声的连接很容易被 frp / nginx / 运营商网关当成死连接切掉。
    graceTimer = setTimeout(() => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        })
        // writeHead 只是把响应头排进缓冲区，真正发出去要等第一次 write。
        // 这里必须显式刷新，否则「先给 200」等于没给，客户端照样干等。
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
      } catch {
        return
      }
      sseSelfHeaded = true
      lastDownAt = Date.now()
      startPing()
    }, SSE_GRACE_MS)
    if (typeof graceTimer.unref === 'function') graceTimer.unref()
  }

  let clientAborted = false
  req.on('aborted', () => {
    clientAborted = true
    try {
      proxyReq.destroy()
    } catch {
      /* ignore */
    }
  })

  // 客户端先走了（关页面、切标签、SSE 被前端 close()）：
  // 定时器要收，上游请求也要断 —— 否则 SSE 的上游连接会一直挂着别后端的资源。
  res.on('close', () => {
    stopPing()
    clearWaitTimers()
    if (!res.writableEnded && !clientAborted) {
      clientAborted = true
      try {
        proxyReq.destroy()
      } catch {
        /* ignore */
      }
    }
  })

  proxyReq.on('error', err => {
    clearWaitTimers()
    stopPing()
    st.errors++
    st.lastAt = Date.now()
    st.lastMs = Date.now() - startedAt
    // 只有「一个字节的响应都没收到」才算连不上（502）。
    // 如果后端已经回了状态行/部分响应体再断链，真实状态码早就记下了，
    // 这里不该把它改写成 502 —— 否则状态页会显示成完全连不上，误导排查方向。
    const noResponseYet = !res.headersSent
    if (noResponseYet) st.lastStatus = 502

    const sent = {
      head: proxyReq._header ? proxyReq._header.length : 0,
      body: bodyData ? bodyData.length : 0,
      connected,
      waitedMs: Date.now() - startedAt,
    }
    // 客户端先挂断（关页面、切标签）时这里记过一笔，proxyReq 是被我们主动 destroy 的。
    // 那不是后端的问题，别记 warn 刷屏。注意不能看 res.destroyed —— 它在转发失败
    // 路径上也可能已经是 true，会把真正的后端故障吞掉。
    if (clientAborted || req.aborted === true) return

    warnOnce(
      route,
      `[web-mount] 转发失败 ${route.name || route.matchPath} -> ${route.host}:${route.port}${proxyPath}`
        + ` : ${err.message}（${explainError(err, sent)}）`,
    )

    if (noResponseYet) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(
        `502 Bad Gateway\n${route.name || route.matchPath} -> ${route.host}:${route.port}${proxyPath}\n${err.message}\n`,
      )
    } else {
      res.destroy()
    }
  })

  if (bodyData) {
    // body-parser 已经读完的请求：用序列化后的 body 重发
    proxyReq.write(bodyData)
    proxyReq.end()
  } else if (!hadBody) {
    // 明确没有请求体（GET 或 content-length: 0）的请求。
    // 之前这里走 req.pipe()，而空流可能早已 end，pipe 不会再触发 end，
    // 后端就一直等 —— 表现为「这个请求要卡 30 秒才返回」。必须显式 end()。
    proxyReq.end()
  } else {
    // 有请求体且尚未被消费：保持流式转发，大文件上传不占内存
    req.pipe(proxyReq)
  }
}

/* ---------- WebSocket 反向代理 ----------
 * 这里手写 101 响应而不是用库：Yunzai 的 http server 已经把 socket 交出来了，
 * 只需要把握手报文原样搬给客户端，之后两端裸 socket 互泵即可。
 */
export function forwardWs(req, socket, head, targetPath, route) {
  const headers = { ...req.headers }
  const originHost = headers.host || ''
  // 与 HTTP 转发保持一致：默认保留客户端 Host，否则后端的 Origin 校验会把
  // WS 握手当成跨站请求拒掉（NapCat 这类面板的实时日志/事件推送都走 WS）。
  if (state.settings.preserveHost === false) {
    headers.host = `${route.host}:${route.port}`
  }
  headers['x-forwarded-host'] = originHost
  headers['x-forwarded-prefix'] = route.matchPath

  const proxy = http.request({
    host: route.host,
    port: route.port,
    path: targetPath || '/',
    method: req.method,
    headers,
  })

  proxy.on('upgrade', (pRes, pSocket, pHead) => {
    let raw = `HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || 'Switching Protocols'}\r\n`
    for (const k in pRes.headers) {
      const v = pRes.headers[k]
      if (Array.isArray(v)) for (const item of v) raw += `${k}: ${item}\r\n`
      else raw += `${k}: ${v}\r\n`
    }
    raw += '\r\n'
    socket.write(raw)

    // upgrade 之后两端都可能已有首包数据，先各自倒进去
    if (pHead && pHead.length) socket.write(pHead)
    if (head && head.length) pSocket.write(head)

    pSocket.pipe(socket)
    socket.pipe(pSocket)

    const closeBoth = () => {
      try {
        pSocket.destroy()
      } catch {
        /* ignore */
      }
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    pSocket.on('error', closeBoth)
    socket.on('error', closeBoth)
    pSocket.on('close', closeBoth)
    socket.on('close', closeBoth)

    if (state.settings.debug) {
      logger.mark(`[web-mount] WS 已连接 ${req.url} -> ${route.host}:${route.port}${targetPath}`)
    }
  })

  proxy.on('response', () => {
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  proxy.on('error', err => {
    logger.warn(
      `[web-mount] WS 转发失败 ${route.name || route.matchPath} -> ${route.host}:${route.port} : ${err.message}`,
    )
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  proxy.end()
}
