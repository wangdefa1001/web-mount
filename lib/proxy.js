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

/* 同一路由 10 秒内只记一条，避免后端整体挂掉时刷屏 */
function warnOnce(route, msg) {
  const now = Date.now()
  const key = statKey(route)
  if (now - (state.errLogged.get(key) || 0) > 10000) {
    state.errLogged.set(key, now)
    logger.warn(msg)
  }
}

/* 把转发失败翻译成「下一步该查什么」。
 * 光有 err.message 没法判断责任方：socket hang up 可能是后端根本没在监听、
 * 也可能是后端进程重启、还可能是它主动踢掉了这条连接。
 */
function explainError(err, sent) {
  const base = {
    ECONNREFUSED: '后端端口没有进程在监听 —— 服务没启动，或监听在别的地址',
    ENOTFOUND: '解析不到该主机名',
    ETIMEDOUT: '连接后端超时',
    EHOSTUNREACH: '主机不可达',
  }
  if (base[err.code]) return base[err.code]
  if (err.message === 'socket hang up') {
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
  headers.host = `${route.host}:${route.port}`

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

  const proxyReq = http.request(
    { host: route.host, port: route.port, path: proxyPath || '/', method: req.method, headers },
    pRes => {
      st.lastStatus = pRes.statusCode || 0
      st.lastMs = Date.now() - startedAt
      st.lastAt = Date.now()

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

      if (!res.headersSent) res.writeHead(pRes.statusCode || 502, resHeaders)
      pRes.on('error', () => {
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
  const timeout = Number(state.settings.proxyTimeout) || DEFAULT_SETTINGS.proxyTimeout
  let connected = false
  proxyReq.on('socket', s => {
    if (!s.connecting) connected = true
    else s.once('connect', () => (connected = true))
  })
  proxyReq.setTimeout(timeout, () => proxyReq.destroy(new Error(`timeout after ${timeout}ms`)))

  let clientAborted = false
  req.on('aborted', () => {
    clientAborted = true
    try {
      proxyReq.destroy()
    } catch {
      /* ignore */
    }
  })

  proxyReq.on('error', err => {
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
  headers.host = `${route.host}:${route.port}`
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
