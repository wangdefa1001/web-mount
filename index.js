import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import plugin from '../../lib/plugins/plugin.js'
import {
  state, statKey, statOf, probe,
  touchTraffic, trafficBuckets, resetStats, collectStatus,
} from './lib/status.js'
import {
  DEFAULT_SETTINGS, configPaths, ensureConfig, readConfigFile,
  normalizeConfig, readSettings, saveFromEditor, readEditorData,
} from './lib/config.js'

/* ------------------------------------------------------------------ *
 * 统一路由模型：
 *   每条 route = { enable, name, matchPath, matchReferer, matchMethod, host, port, prefix, ws }
 *   - matchPath     监听/匹配的 URL 路径前缀(如 /api /login /memes)
 *   - matchReferer  来源(Referer/Origin)包含此字符串才命中，| 分隔多个，留空=不限制
 *   - matchMethod   HTTP 方法限制(GET|POST ...)，留空=不限制
 *   - 命中 = matchPath 匹配 && matchReferer 匹配 && matchMethod 匹配
 *   - 多条规则按「路径越长越优先，同长度保持配置顺序」匹配，首条命中即转发
 * ------------------------------------------------------------------ */

/* ---------- 路径定位 ---------- */
let pluginDir = path.join(process.cwd(), 'plugins/web-mount')
try {
  pluginDir = path.dirname(fileURLToPath(import.meta.url))
} catch { /* 非 ESM 环境回退到 cwd */ }
const CFG_PATHS = configPaths(pluginDir)
const configPath = CFG_PATHS.file

const STATUS_PATH = '/__web-mount__'

/* ---------- 工具函数 ---------- */
// 取 URL 去掉查询串后的路径
function pathnameOf(url) {
  return (url || '').split('?')[0]
}
// 取查询串（含 ?）
function queryOf(url) {
  return url.includes('?') ? url.slice(url.indexOf('?')) : ''
}
// 计算子路径：/api/foo 命中 /api -> '/foo'；/api 精确命中 -> ''；不命中 -> null
function subPath(pathname, mp) {
  mp = mp || '/'
  if (mp === '/') return pathname
  if (pathname === mp) return ''
  if (pathname.startsWith(mp + '/')) return pathname.slice(mp.length)
  return null
}
// 拼接「目标内前缀 + 子路径」，避免出现 //。
// prefix 为 '/' 表示映射到后端根目录，也就是「剥掉挂载前缀」(适合配了 base path 的面板，如青龙 QlBaseUrl)
function joinPath(prefix, sub) {
  let p = prefix || ''
  if (p !== '/') p = p.replace(/\/+$/, '')
  if (p === '/') p = ''
  let s = sub || ''
  if (s === '') return p === '' ? '/' : p
  if (!s.startsWith('/')) s = '/' + s
  return p + s
}
// 模式命中：支持 | 或 , 分隔多关键字(OR)
function hasAny(hay, pat) {
  if (!pat) return false
  return String(pat).split(/[|,]/).some(p => p && hay.includes(p.trim()))
}

/* 来源分流的请求来源。两条原则：
 *  1. 只取 Referer / Origin 的 pathname —— 拿完整 URL 直接做子串匹配时，
 *     查询串里的 ?q=/zy 也会命中，属于误匹配。
 *  2. Referer 由客户端完全掌控，任意站点都能伪造。开启 refererSameOriginOnly 时，
 *     只有 host 等于本次请求 Host 的来源才参与分流；跨站来源一律走「没有来源限制」
 *     的兜底路由。这一条直接堵住「陌生网页把 /api 打到自己后端」的口子。
 */
function refContext(headers, settings) {
  const raw = []
  if (headers.referer) raw.push(headers.referer)
  if (headers.origin) raw.push(headers.origin)
  const selfHost = String(headers.host || '').toLowerCase()
  const sameOriginOnly = settings.refererSameOriginOnly !== false
  const parts = []
  for (const u of raw) {
    let host = ''
    let pname = u
    try {
      const url = new URL(u)
      host = url.host.toLowerCase()
      pname = url.pathname
    } catch {
      // 相对/畸形值（部分原生客户端会这么发）：没有 host 信息，按原文参与匹配
      // 但只保留 path 部分之前的字符，避免把查询串当路径
      pname = u.split('?')[0].split('#')[0]
    }
    if (sameOriginOnly && host && selfHost && host !== selfHost) continue
    parts.push(pname)
  }
  return parts.join(' ')
}

function routeMatches(r, ref, pathname, method) {
  if (subPath(pathname, r.matchPath) === null) return false
  if (r.matchReferer && !hasAny(ref, r.matchReferer)) return false
  if (r.matchMethod && !hasAny(method, r.matchMethod.toUpperCase())) return false
  return true
}

// HTTP 与 WebSocket 共用同一套匹配逻辑，避免 WS 绕过来源/方法限制
function findRoute(pathname, ref, method) {
  return state.routes.find(r => routeMatches(r, ref, pathname, method))
}
// 最长路径优先；同长度保持配置顺序(保证 /api 按来源分流的顺序不被破坏)
function sortRoutes(list) {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.matchPath.length - a.r.matchPath.length) || (a.i - b.i))
    .map(x => x.r)
}

/* ---------- 配置读取 / 归一化 / 旧格式迁移 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
// 定长比较，避免按字符逐位比较泄露信息
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}
function fmtTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ------------------------------------------------------------------ *
 * 主插件
 * ------------------------------------------------------------------ */
export default class WebMount extends plugin {
  constructor() {
    super({ name: 'web-mount' })
  }

  async init() {
    if (!Bot.express || !Bot.server) {
      logger.warn('[web-mount] 未检测到 Bot.express / Bot.server，插件未生效（请确认 Yunzai 的 HTTP 服务已开启）')
      return false
    }

    this.reloadConfig(false)

    // 暴露给锅巴扩展页面(guoba/index.js)调用，两者共用同一份运行时状态
    globalThis.__webMountApi = {
      reload: () => {
        this.reloadConfig(true)
        return state.routes.length
      },
      collect: () => collectStatus(),
      reset: () => resetStats(),
      editor: () => readEditorData(pluginDir, logger),
      save: (data) => {
        saveFromEditor(pluginDir, data, logger)
        this.reloadConfig(true)
        return state.routes.length
      },
      stats: () => ({ routes: state.routes.length, startedAt: state.startedAt }),
    }

    this.registerHttp()
    this.registerWs()
    this.startWatcher()
    this.printRoutes()

    return true
  }

  /* ---------- 配置加载 / 热重载 ---------- */
  reloadConfig(isReload) {
    ensureConfig(pluginDir, logger)
    const raw = readConfigFile(pluginDir, logger)
    if (!raw) logger.error('[web-mount] 读取 config.json 失败（将使用空路由）')
    const cfg = normalizeConfig(raw || {})

    state.settings = readSettings(cfg)

    const all = cfg.routes || []
    state.allRoutes = all
    // routes：匹配用，最长路径优先。端口非法的条目在这里被排除，
    // 但 allRoutes 里仍保留（带 __invalidPort 标记），启动日志会点名。
    state.routes = sortRoutes(all.filter(r => r.enable && r.port))
    // displayRoutes：展示用，保持配置里的原始顺序
    state.displayRoutes = all.filter(r => r.enable && r.port)
    state.wsRoutes = state.routes.filter(r => r.ws)

    if (isReload) {
      logger.mark(`[web-mount] 配置已热重载，当前生效 ${state.routes.length} 条路由`)
    }
    return cfg
  }

  // 监听 config.json 修改时间，实现保存即生效(免重启)
  startWatcher() {
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    if (!state.settings.autoReload) return

    let lastMtime = 0
    try { lastMtime = fs.statSync(configPath).mtimeMs } catch { /* ignore */ }

    state.timer = setInterval(() => {
      if (!state.settings.autoReload) return
      let m = 0
      try { m = fs.statSync(configPath).mtimeMs } catch { return }
      if (m && m !== lastMtime) {
        lastMtime = m
        // 稍等写入落盘再读
        setTimeout(() => {
          try {
            this.reloadConfig(true)
          } catch (e) {
            logger.error('[web-mount] 热重载失败: ' + e.message)
          }
        }, 120)
      }
    }, 2000)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  /* ---------- HTTP 中间件注册(防热重载重复挂载) ---------- */
  registerHttp() {
    if (state.httpRegistered) return
    state.httpRegistered = true
    try {
      Bot.express.use((req, res, next) => this.handle(req, res, next))
    } catch (e) {
      state.httpRegistered = false
      logger.error('[web-mount] HTTP 中间件注册失败: ' + e.message)
    }
  }

  /* ---------- WebSocket upgrade 注册 ---------- */
  registerWs() {
    if (state.wsRegistered) return
    state.wsRegistered = true
    try {
      Bot.server.prependListener('upgrade', (req, socket, head) => {
        if (!state.wsRoutes.length) return
        const pathname = pathnameOf(req.url || '')
        // 只在这个子集里匹配 WS 路由（wsRoutes 已按最长路径优先排好）
        const ref = refContext(req.headers, state.settings)
        const route = state.wsRoutes.find(r => routeMatches(r, ref, pathname, 'GET'))
        if (!route) return
        const sub = subPath(pathname, route.matchPath)
        const targetPath = joinPath(route.prefix, sub) + queryOf(req.url || '')
        statOf(route).count++
        touchTraffic()
        this.forwardWs(req, socket, head, targetPath, route)
      })
    } catch (e) {
      state.wsRegistered = false
      logger.error('[web-mount] WS 监听注册失败: ' + e.message)
    }
  }

  /* ---------- 请求处理 ---------- */
  handle(req, res, next) {
    const url = req.originalUrl || req.url || '/'
    const pathname = pathnameOf(url)
    const cfg = state.settings

    // 内置状态页(优先于所有路由)
    const isStatus = pathname === STATUS_PATH || pathname === STATUS_PATH + '/' ||
      pathname.startsWith(STATUS_PATH + '/')
    if (cfg.statusPage && isStatus) {
      this.handleStatus(req, res, url, pathname).catch(e => {
        logger.error('[web-mount] 状态页处理失败: ' + e.message)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('状态页内部错误: ' + e.message)
      })
      return
    }

    if (!state.routes.length) return next()

    const ref = refContext(req.headers, cfg)
    const method = (req.method || 'GET').toUpperCase()

    const route = findRoute(pathname, ref, method)
    if (!route) return next()

    // 精确命中且无尾斜杠的 GET：补一个 /，否则页面里的相对资源(./x.js)会解析错。
    // 只对「没有来源/方法限制」的路由做（那条路由就是页面根），避免把分流请求也跳走。
    // 某些 SPA 对多一次跳转敏感，可用 trailingSlashRedirect: false 关掉。
    if (cfg.trailingSlashRedirect !== false &&
        !route.matchReferer && !route.matchMethod && (method === 'GET' || method === 'HEAD') &&
        route.matchPath !== '/' && pathname === route.matchPath) {
      res.writeHead(302, { location: route.matchPath + '/' + queryOf(url) })
      return res.end()
    }

    const sub = subPath(pathname, route.matchPath)
    const proxyPath = joinPath(route.prefix, sub) + queryOf(url)
    this.forward(req, res, proxyPath, route)
  }

  /* ---------- HTTP 反向代理 ---------- */
  forward(req, res, proxyPath, route) {
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
      bodyData = this.bodyToBuffer(req.body)
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
          logger.mark(`[web-mount] ${req.method} ${req.url} -> ${route.host}:${route.port}${proxyPath} ${st.lastStatus} ${st.lastMs}ms`)
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
        pRes.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
        pRes.pipe(res)
      }
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
        logger.warn(`[web-mount] 转发失败 ${route.name || route.matchPath} -> ${route.host}:${route.port} : ${err.message}`)
      }

      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end(`502 Bad Gateway\n${route.name || route.matchPath} -> ${route.host}:${route.port}${proxyPath}\n${err.message}`)
    })

    req.on('aborted', () => { try { proxyReq.destroy() } catch { /* ignore */ } })

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

  bodyToBuffer(body) {
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

  /* ---------- WebSocket 反向代理 ---------- */
  forwardWs(req, socket, head, targetPath, route) {
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
        try { pSocket.destroy() } catch { /* ignore */ }
        try { socket.destroy() } catch { /* ignore */ }
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
      logger.warn(`[web-mount] WS 转发失败 ${route.name || route.matchPath} -> ${route.host}:${route.port} : ${err.message}`)
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    proxy.end()
  }

  /* ---------- 状态页 ---------- */
  authCookieValue(token) {
    return crypto.createHash('sha256').update('web-mount::' + token).digest('hex')
  }

  checkAuth(req) {
    const token = state.settings.statusToken
    if (!token) return true
    const cookie = req.headers.cookie || ''
    const m = cookie.match(/(?:^|;\s*)wm_auth=([^;]+)/)
    if (m && m[1] === this.authCookieValue(token)) return true
    const h = req.headers['x-wm-token']
    if (typeof h === 'string' && h && h === token) return true
    return false
  }

  sendJson(res, code, obj) {
    const body = JSON.stringify(obj, null, 2)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  // 读取表单 body。
  // 注意：不能只靠 req._body 判断 —— 部分 Yunzai/express 版本只把解析结果放进 req.body，
  // 并不设置 _body，此时若按「未解析」去读流，流早已读完，会拿到空字符串（表现为“口令不正确”）。
  // 策略：req.body 有实际内容就用它，否则再尝试读流。
  readFormBody(req) {
    return new Promise(resolve => {
      const body = req.body
      if (body != null) {
        if (typeof body === 'string') {
          if (body) return resolve(body)
        } else if (Buffer.isBuffer(body)) {
          if (body.length) return resolve(body.toString('utf8'))
        } else if (typeof body === 'object') {
          const keys = Object.keys(body)
          if (keys.length) {
            const p = new URLSearchParams()
            for (const k of keys) p.set(k, String(body[k]))
            return resolve(p.toString())
          }
        }
      }
      if (req.readableEnded) return resolve('')
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size <= 65536) chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  // 读取 JSON 请求体（配置区保存用）
  readJsonBody(req) {
    return new Promise(resolve => {
      const body = req.body
      if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return resolve(body)
      if (typeof body === 'string' && body) {
        try { return resolve(JSON.parse(body)) } catch { return resolve(null) }
      }
      if (req.readableEnded) return resolve(null)
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size <= 1048576) chunks.push(c)
      })
      req.on('end', () => {
        try {
          const txt = Buffer.concat(chunks).toString('utf8')
          resolve(txt ? JSON.parse(txt) : null)
        } catch { resolve(null) }
      })
      req.on('error', () => resolve(null))
    })
  }

  async handleStatus(req, res, url, pathname) {
    const cfg = state.settings
    const sub = pathname.slice(STATUS_PATH.length).replace(/\/+$/, '')
    const authed = this.checkAuth(req)

    if (sub === '/logout') {
      res.writeHead(302, {
        'set-cookie': 'wm_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        location: STATUS_PATH,
      })
      return res.end()
    }

    if (!authed) {
      if (sub === '/reload' || sub === '/reset' || sub === '/config') return this.sendJson(res, 401, { ok: false, message: '未授权' })
      if (/[?&]format=json\b/.test(url)) return this.sendJson(res, 401, { ok: false, message: '未授权' })
      if (req.method === 'POST' && sub === '') return this.handleLogin(req, res)
      return this.renderLogin(res, '')
    }

    if (sub === '/reload') {
      try {
        this.reloadConfig(true)
        return this.sendJson(res, 200, { ok: true, message: `已重载，生效 ${state.routes.length} 条`, routes: state.routes.length })
      } catch (e) {
        return this.sendJson(res, 500, { ok: false, message: e.message })
      }
    }

    if (sub === '/reset') {
      resetStats()
      return this.sendJson(res, 200, { ok: true, message: '统计已清空' })
    }

    // 配置区：读 / 写 config.json
    if (sub === '/config') {
      if (!cfg.configEditor) {
        return this.sendJson(res, 403, { ok: false, message: '配置编辑已在设置中关闭' })
      }
      if (req.method === 'GET') {
        return this.sendJson(res, 200, { ok: true, result: readEditorData(pluginDir, logger) })
      }
      if (req.method === 'POST') {
        // 未设口令时状态页本身就是公开的，不能让任何人改配置
        if (!cfg.statusToken) {
          return this.sendJson(res, 403, {
            ok: false,
            message: '未设置访问口令，配置功能已禁用。请先在锅巴面板设置口令，或在面板内直接编辑。',
          })
        }
        const body = await this.readJsonBody(req)
        if (!body) return this.sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
        try {
          saveFromEditor(pluginDir, body, logger)
          this.reloadConfig(true)
          return this.sendJson(res, 200, { ok: true, message: `已保存并生效，共 ${state.routes.length} 条路由` })
        } catch (e) {
          return this.sendJson(res, 500, { ok: false, message: '保存失败：' + e.message })
        }
      }
      return this.sendJson(res, 405, { ok: false, message: '不支持的请求方法' })
    }

    if (sub) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }

    const data = await collectStatus()
    if (/[?&]format=json\b/.test(url)) return this.sendJson(res, 200, data)
    return this.renderStatusPage(res, data)
  }

  async handleLogin(req, res) {
    const ip = req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    const rec = state.loginFails.get(ip) || { n: 0, until: 0 }

    if (rec.until > now) {
      return this.renderLogin(res, `尝试次数过多，请 ${Math.ceil((rec.until - now) / 1000)} 秒后重试`, 429)
    }

    const raw = await this.readFormBody(req)
    let token = ''
    try {
      token = new URLSearchParams(raw).get('token') || ''
    } catch { /* ignore */ }

    const expected = state.settings.statusToken

    if (state.settings.debug) {
      logger.mark(
        `[web-mount] 状态页登录：body ${raw.length} 字节，取到 ${token.length} 字符，` +
        `期望 ${expected.length} 字符，${token && safeEqual(token, expected) ? '匹配' : '不匹配'}`
      )
    }

    if (token && safeEqual(token, expected)) {
      state.loginFails.delete(ip)
      res.writeHead(302, {
        'set-cookie': `wm_auth=${this.authCookieValue(expected)}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`,
        location: STATUS_PATH,
      })
      return res.end()
    }

    // 没取到 token：多半是请求体没读到（不是口令错），单独提示，且不计入失败次数
    if (!token) {
      return this.renderLogin(res, '没有收到口令，请重新输入', 400)
    }

    rec.n++
    if (rec.n >= 5) {
      rec.until = now + 60000
      rec.n = 0
    }
    state.loginFails.set(ip, rec)
    return this.renderLogin(res, '口令不正确，请重试', 401)
  }

  /* ---- 登录页 ---- */
  renderLogin(res, error, code) {
    const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>web-mount · 验证</title>
<style>
  :root{
    --bg:#f5f7fa; --card:#ffffff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb;
    --accent:#3b82f6; --accent2:#8b5cf6; --bad:#ef4444;
    --shadow:0 10px 40px -12px rgba(17,24,39,.18);
  }
  @media (prefers-color-scheme: dark){
    :root{--bg:#0b0e14; --card:#141922; --fg:#e6edf3; --muted:#94a3b8; --line:#232b38;
          --accent:#60a5fa; --accent2:#a78bfa; --bad:#f87171;
          --shadow:0 10px 40px -12px rgba(0,0,0,.7);}
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;display:grid;place-items:center;padding:24px;
    background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background-image:radial-gradient(900px 400px at 50% -10%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%);
  }
  .box{
    width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);
    border-radius:18px;padding:32px 28px;box-shadow:var(--shadow);
  }
  .logo{
    width:46px;height:46px;border-radius:14px;display:grid;place-items:center;
    background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
    font-size:22px;margin-bottom:18px;box-shadow:0 6px 18px -6px var(--accent);
  }
  h1{margin:0 0 6px;font-size:19px;letter-spacing:.2px}
  p.sub{margin:0 0 22px;color:var(--muted);font-size:13px}
  label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:7px;font-weight:600}
  input[type=password],input[type=text]{
    width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);
    background:color-mix(in srgb, var(--bg) 55%, var(--card));color:var(--fg);
    font-size:15px;outline:none;transition:.18s;letter-spacing:.3px;
  }
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)}
  button{
    width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;cursor:pointer;
    background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
    font-size:15px;font-weight:600;letter-spacing:.3px;transition:.18s;
  }
  button:hover{filter:brightness(1.06)}
  button:active{transform:translateY(1px)}
  .err{
    margin-top:14px;padding:9px 12px;border-radius:9px;font-size:13px;
    background:color-mix(in srgb, var(--bad) 12%, transparent);
    color:var(--bad);border:1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  }
  .foot{margin-top:18px;text-align:center;color:var(--muted);font-size:12px}
</style></head>
<body>
<form class="box" method="POST" action="${STATUS_PATH}">
  <div class="logo">◈</div>
  <h1>web-mount 状态面板</h1>
  <p class="sub">该面板已设置访问口令，请输入后继续</p>
  <label for="token">访问口令</label>
  <input id="token" name="token" type="password" placeholder="请输入口令" autocomplete="current-password" autofocus required>
  <button type="submit">进入面板</button>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <div class="foot">口令可在锅巴面板 → 端口挂载 → 「状态页口令」里修改</div>
</form>
</body></html>`

    res.writeHead(code || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  /* ---- 仪表盘 ---- */
  // 状态页与锅巴扩展页面共用 guoba/ 下的 html/css/js，避免维护两套界面。
  // 独立页把 css/js 内联进来（自包含），锅巴页则由锅巴的静态资源服务提供。
  renderStatusPage(res, data) {
    try {
      const guobaDir = path.join(pluginDir, 'guoba')
      let html = fs.readFileSync(path.join(guobaDir, 'dashboard.html'), 'utf8')
      const css = fs.readFileSync(path.join(guobaDir, 'dashboard.css'), 'utf8')
      const js = fs.readFileSync(path.join(guobaDir, 'dashboard.js'), 'utf8')

      const payload = JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')

      html = html
        .replace('<link rel="stylesheet" href="dashboard.css">', '<style>\n' + css + '\n</style>')
        .replace('<script src="dashboard.js"></script>', '<script>window.__WM__=' + payload + ';window.__WM_PATH__=' + JSON.stringify(STATUS_PATH) + ';</script>\n<script>\n' + js + '\n</script>')

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    } catch (e) {
      logger.error('[web-mount] 渲染状态页失败: ' + e.message)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('状态页资源缺失（guoba/dashboard.html|css|js），请确认插件文件完整')
    }
  }

  /* ---------- 启动日志 ---------- */
  printRoutes() {
    const routes = (state.displayRoutes && state.displayRoutes.length) ? state.displayRoutes : state.routes
    const skipped = state.allRoutes.filter(r => r.enable && !r.port)
    for (const r of routes) {
      const src = r.matchReferer ? `(来源 ${r.matchReferer})` : ''
      const mtd = r.matchMethod ? `(仅 ${r.matchMethod})` : ''
      const prefixTxt = r.prefix && r.prefix !== '/' ? r.prefix : ''
      logger.mark(
        `[web-mount] ${r.matchPath}${src}${mtd} -> ${r.host}:${r.port}${prefixTxt} 已挂载${r.ws ? '(含WS)' : ''}${r.name ? ' [' + r.name + ']' : ''}`
      )
    }

    if (routes.length) {
      const list = routes.map(r => r.matchPath + (r.matchReferer ? `<${r.matchReferer}>` : '')).join(' ')
      logger.mark(`[web-mount] 启动完成，已挂载 ${routes.length} 条: ${list}`)
    } else {
      logger.warn('[web-mount] 没有可用的路由，请在 config.json 或锅巴面板里添加')
    }

    if (skipped.length) {
      logger.warn(`[web-mount] 以下 ${skipped.length} 条因端口无效被跳过（不会转发，请检查端口）: ` +
        skipped.map(r => `${r.name || r.matchPath}(port=${r.__invalidPort || r.port || '空'})`).join(' ; '))
    }
    if (state.settings.statusPage) {
      const tk = state.settings.statusToken
      logger.mark(`[web-mount] 状态页: ${STATUS_PATH}${tk ? `（已设口令，长度 ${tk.length}）` : '（未设口令，建议公网暴露时设置）'}`)
    }
    if (state.settings.autoReload) {
      logger.mark('[web-mount] 已开启配置热重载，修改 config.json 后约 2 秒自动生效')
    }
  }
}
