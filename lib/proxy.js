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

  // 超时保护：后端卡死时释放连接，避免请求一直挂着
  const timeout = Number(state.settings.proxyTimeout) || DEFAULT_SETTINGS.proxyTimeout
  proxyReq.setTimeout(timeout, () => proxyReq.destroy(new Error(`timeout after ${timeout}ms`)))

  proxyReq.on('error', err => {
    st.errors++
    st.lastStatus = 502
    st.lastAt = Date.now()
    st.lastMs = Date.now() - startedAt

    // 同一路由 10 秒内只记一条，避免后端整体挂掉时刷屏
    const now = Date.now()
    const lastLog = state.errLogged.get(statKey(route)) || 0
    if (now - lastLog > 10000) {
      state.errLogged.set(statKey(route), now)
      logger.warn(
        `[web-mount] 转发失败 ${route.name || route.matchPath} -> ${route.host}:${route.port} : ${err.message}`,
      )
    }

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    res.end(
      `502 Bad Gateway\n${route.name || route.matchPath} -> ${route.host}:${route.port}${proxyPath}\n${err.message}`,
    )
  })

  req.on('aborted', () => {
    try {
      proxyReq.destroy()
    } catch {
      /* ignore */
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
