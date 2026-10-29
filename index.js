import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import plugin from '../../lib/plugins/plugin.js'

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
const configDir = path.join(pluginDir, 'config')
const configPath = path.join(configDir, 'config.json')
const defaultConfigPath = path.join(configDir, 'default_config.json')

const STATUS_PATH = '/__web-mount__'

const DEFAULT_SETTINGS = {
  debug: false,
  autoReload: true,
  statusPage: true,
  statusToken: '',
  proxyTimeout: 30000,
}

/* ---------- 工具函数 ---------- */
function normPort(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 0
}
function normStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}
// 路径归一化：补前导 /、去掉尾部多余 /
function normPath(p) {
  let s = normStr(p)
  if (!s) return ''
  if (s !== '/' && !s.startsWith('/')) s = '/' + s
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  return s
}
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
function routeMatches(r, ref, pathname, method) {
  if (subPath(pathname, r.matchPath) === null) return false
  if (r.matchReferer && !hasAny(ref, r.matchReferer)) return false
  if (r.matchMethod && !hasAny(method, r.matchMethod.toUpperCase())) return false
  return true
}
// 最长路径优先；同长度保持配置顺序(保证 /api 按来源分流的顺序不被破坏)
function sortRoutes(list) {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.matchPath.length - a.r.matchPath.length) || (a.i - b.i))
    .map(x => x.r)
}

/* ---------- 跨热重载共享的状态 ---------- */
const G = globalThis
if (!G.__webMountState) {
  G.__webMountState = {
    routes: [],
    wsRoutes: [],
    allRoutes: [],
    settings: { ...DEFAULT_SETTINGS },
    stats: new Map(),
    errLogged: new Map(),
    httpRegistered: false,
    wsRegistered: false,
    timer: null,
    startedAt: Date.now(),
    // 状态页：最近 60 秒的秒级请求计数 / 后端探测缓存 / 登录失败限流
    secBuckets: new Map(),
    health: new Map(),
    healthAt: 0,
    loginFails: new Map(),
  }
}
const state = G.__webMountState

function statKey(r) {
  return `${r.matchPath}|${r.matchReferer || ''}|${r.host}:${r.port}|${r.prefix}`
}
function statOf(r) {
  const k = statKey(r)
  let s = state.stats.get(k)
  if (!s) {
    s = { count: 0, errors: 0, lastStatus: 0, lastAt: 0, lastMs: 0 }
    state.stats.set(k, s)
  }
  return s
}

/* ---------- 配置读取 / 归一化 / 旧格式迁移 ---------- */
function ensureConfig() {
  try {
    if (!fs.existsSync(configPath) && fs.existsSync(defaultConfigPath)) {
      fs.mkdirSync(configDir, { recursive: true })
      fs.copyFileSync(defaultConfigPath, configPath)
      logger.info('[web-mount] 未找到 config.json，已从 default_config.json 复制模板')
    }
  } catch (e) {
    logger.error('[web-mount] 复制默认配置失败: ' + e.message)
  }
}

function normalizeRoute(r) {
  const matchPath = normPath(r && r.matchPath) || '/'
  return {
    enable: !!r.enable,
    name: normStr(r.name) || (matchPath + (r.matchReferer ? ' [' + normStr(r.matchReferer) + ']' : '')),
    matchPath,
    matchReferer: normStr(r.matchReferer),
    matchMethod: normStr(r.matchMethod).toUpperCase(),
    host: normStr(r.host) || '127.0.0.1',
    port: normPort(r.port),
    prefix: normPath(r.prefix) || '/',
    ws: !!r.ws,
  }
}

// 保留 raw 里的其它顶层字段(如 debug/autoReload)，只替换 routes，
// 避免锅巴保存后把全局设置抹掉。
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { routes: [] }
  const base = { ...raw }

  if (Array.isArray(raw.routes)) {
    base.routes = raw.routes.map(normalizeRoute).filter(r => r.port)
    return base
  }

  // 旧格式：由 mounts + dispatch 迁移为统一 routes
  const routes = []
  for (const m of raw.mounts || []) {
    routes.push(normalizeRoute({
      enable: m.enable, name: m.note, matchPath: m.path, matchReferer: '',
      host: m.host, port: m.port, prefix: m.prefix, ws: m.ws,
    }))
  }
  const d = raw.dispatch || {}
  if (d.enable) {
    const dp = normPath(d.path) || '/api'
    for (const r of d.rules || []) {
      routes.push(normalizeRoute({
        enable: r.enable, name: r.name, matchPath: dp,
        matchReferer: r.matchReferer || '', host: r.host, port: r.port, prefix: r.prefix,
      }))
    }
    const f = d.fallback || {}
    if (f.enable && normPort(f.port)) {
      routes.push(normalizeRoute({
        enable: true, name: '兜底', matchPath: dp, matchReferer: '', host: f.host, port: f.port, prefix: f.prefix,
      }))
    }
  }
  base.routes = routes.filter(r => r.port)
  return base
}

function loadRawConfig() {
  ensureConfig()
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (e) {
    logger.error('[web-mount] 读取 config.json 失败(将使用空路由): ' + e.message)
    return null
  }
}

/* ---------- 后端连通性探测 ---------- */
function probe(host, port, timeout = 800) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ online: ok, ping: ok ? Date.now() - t0 : -1 })
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/* ---------- 最近 60 秒流量 ---------- */
function touchTraffic() {
  const sec = Math.floor(Date.now() / 1000)
  state.secBuckets.set(sec, (state.secBuckets.get(sec) || 0) + 1)
  if (state.secBuckets.size > 180) {
    const cut = sec - 120
    for (const k of state.secBuckets.keys()) if (k < cut) state.secBuckets.delete(k)
  }
}
function trafficBuckets() {
  const nowSec = Math.floor(Date.now() / 1000)
  const out = new Array(60).fill(0)
  for (let i = 0; i < 60; i++) out[i] = state.secBuckets.get(nowSec - 59 + i) || 0
  return out
}

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
    this.registerHttp()
    this.registerWs()
    this.startWatcher()
    this.printRoutes()

    return true
  }

  /* ---------- 配置加载 / 热重载 ---------- */
  reloadConfig(isReload) {
    const raw = loadRawConfig() || {}
    const cfg = normalizeConfig(raw)

    const timeout = Number(cfg.proxyTimeout)
    state.settings = {
      debug: !!cfg.debug,
      autoReload: cfg.autoReload === undefined ? true : !!cfg.autoReload,
      statusPage: cfg.statusPage === undefined ? true : !!cfg.statusPage,
      statusToken: normStr(cfg.statusToken),
      proxyTimeout: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600000) : DEFAULT_SETTINGS.proxyTimeout,
    }

    const all = cfg.routes || []
    state.allRoutes = all
    state.routes = sortRoutes(all.filter(r => r.enable && r.port))
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
        for (const r of state.wsRoutes) {
          const sub = subPath(pathname, r.matchPath)
          if (sub === null) continue
          const targetPath = joinPath(r.prefix, sub) + queryOf(req.url || '')
          statOf(r).count++
          this.forwardWs(req, socket, head, targetPath, r)
          return
        }
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

    const ref = (req.headers.referer || '') + ' ' + (req.headers.origin || '')
    const method = (req.method || 'GET').toUpperCase()

    const route = state.routes.find(r => routeMatches(r, ref, pathname, method))
    if (!route) return next()

    // 精确命中且无尾斜杠的 GET：补一个 /，否则页面里的相对资源(./x.js)会解析错
    if (!route.matchReferer && !route.matchMethod && (method === 'GET' || method === 'HEAD') &&
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
      proxyReq.write(bodyData)
      proxyReq.end()
    } else {
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
      if (sub === '/reload' || sub === '/reset') return this.sendJson(res, 401, { ok: false, message: '未授权' })
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
      state.stats.clear()
      state.secBuckets.clear()
      return this.sendJson(res, 200, { ok: true, message: '统计已清空' })
    }

    if (sub) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }

    const data = await this.collectStatus()
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

  async collectStatus() {
    const cfg = state.settings
    const now = Date.now()

    // 后端探测做 4 秒缓存，避免自动刷新时反复建 TCP 连接
    if (now - state.healthAt > 4000 || state.health.size !== state.routes.length) {
      const list = await Promise.all(state.routes.map(r => probe(r.host, r.port, 700)))
      state.health = new Map(state.routes.map((r, i) => [statKey(r), list[i]]))
      state.healthAt = Date.now()
    }

    const routes = state.routes.map(r => {
      const s = statOf(r)
      const h = state.health.get(statKey(r)) || { online: false, ping: -1 }
      return {
        name: r.name, matchPath: r.matchPath, matchReferer: r.matchReferer,
        matchMethod: r.matchMethod, host: r.host, port: r.port,
        prefix: r.prefix, ws: r.ws,
        online: !!h.online, ping: h.ping,
        count: s.count, errors: s.errors,
        lastStatus: s.lastStatus, lastAt: s.lastAt, lastMs: s.lastMs,
      }
    })

    const latencies = routes.filter(r => r.lastMs > 0).map(r => r.lastMs)
    return {
      now,
      uptime: now - state.startedAt,
      settings: {
        autoReload: cfg.autoReload,
        debug: cfg.debug,
        proxyTimeout: cfg.proxyTimeout,
        secured: !!cfg.statusToken,
      },
      traffic: trafficBuckets(),
      totals: {
        routes: routes.length,
        online: routes.filter(r => r.online).length,
        req: routes.reduce((a, b) => a + b.count, 0),
        err: routes.reduce((a, b) => a + b.errors, 0),
        avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      },
      routes,
    }
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
  renderStatusPage(res, data) {
    const payload = JSON.stringify(data)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')

    const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>web-mount · 挂载状态</title>
<style>
  :root{
    --bg:#f5f7fa; --card:#fff; --fg:#111827; --muted:#6b7280; --line:#e8ebf0;
    --accent:#3b82f6; --accent2:#8b5cf6; --ok:#10b981; --bad:#ef4444; --warn:#f59e0b;
    --chip:#f1f5f9; --shadow:0 1px 2px rgba(17,24,39,.04),0 8px 24px -16px rgba(17,24,39,.28);
  }
  @media (prefers-color-scheme: dark){
    :root{--bg:#0b0e14; --card:#141922; --fg:#e6edf3; --muted:#94a3b8; --line:#232b38;
          --accent:#60a5fa; --accent2:#a78bfa; --ok:#34d399; --bad:#f87171; --warn:#fbbf24;
          --chip:#1b2230; --shadow:0 1px 2px rgba(0,0,0,.5),0 8px 24px -16px rgba(0,0,0,.9);}
  }
  *{box-sizing:border-box}
  body{
    margin:0;padding:20px 18px 40px;background:var(--bg);color:var(--fg);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background-image:radial-gradient(1100px 460px at 50% -12%, color-mix(in srgb, var(--accent) 11%, transparent), transparent 70%);
    background-repeat:no-repeat;
  }
  .wrap{max-width:1160px;margin:0 auto}

  /* 顶栏 */
  .top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  .brand{display:flex;align-items:center;gap:12px}
  .logo{
    width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none;
    background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:19px;
    box-shadow:0 6px 18px -8px var(--accent);
  }
  h1{margin:0;font-size:17px;letter-spacing:.2px}
  .brand p{margin:1px 0 0;font-size:12px;color:var(--muted)}
  .tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .btn{
    display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:9px;cursor:pointer;
    border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:13px;
    font-family:inherit;transition:.16s;text-decoration:none;
  }
  .btn:hover{border-color:var(--accent);color:var(--accent)}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:0}
  .btn.primary:hover{filter:brightness(1.06);color:#fff}
  .tgl{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;font-size:13px;color:var(--muted)}
  .tgl input{display:none}
  .tgl i{
    width:34px;height:19px;border-radius:20px;background:var(--line);position:relative;transition:.2s;flex:none;
  }
  .tgl i::after{
    content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
    background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.25);
  }
  .tgl input:checked + i{background:var(--accent)}
  .tgl input:checked + i::after{transform:translateX(15px)}

  /* 概览卡片 */
  .cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:14px}
  .card{
    background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 15px;
    box-shadow:var(--shadow);position:relative;overflow:hidden;
  }
  .card::before{
    content:"";position:absolute;left:0;top:0;bottom:0;width:3px;
    background:linear-gradient(180deg,var(--accent),var(--accent2));opacity:.9;
  }
  .card span{display:block;font-size:11.5px;color:var(--muted);letter-spacing:.4px;margin-bottom:3px}
  .card b{font-size:23px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
  .card b.ok{color:var(--ok)} .card b.bad{color:var(--bad)}
  .card em{font-style:normal;font-size:11.5px;color:var(--muted);margin-left:4px}

  /* 面板 */
  .panel{
    background:var(--card);border:1px solid var(--line);border-radius:14px;
    box-shadow:var(--shadow);margin-bottom:14px;overflow:hidden;
  }
  .panel-hd{
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;font-weight:600;
  }
  .panel-hd .muted{font-weight:400;color:var(--muted)}
  .panel-hd b{font-variant-numeric:tabular-nums}

  /* 迷你柱状图 */
  .spark{display:flex;align-items:flex-end;gap:2px;height:72px;padding:12px 16px 8px}
  .bar{
    flex:1;min-width:2px;border-radius:2px 2px 0 0;
    background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent2) 70%,transparent));
    transition:height .3s ease, opacity .2s;opacity:.95;
  }
  .bar:hover{opacity:1;filter:brightness(1.15)}
  .bar[data-z]{background:var(--line);opacity:.55}
  .spark-x{display:flex;justify-content:space-between;padding:0 16px 10px;font-size:11px;color:var(--muted)}

  /* 搜索 */
  .search{
    padding:7px 12px;border-radius:9px;border:1px solid var(--line);background:var(--chip);
    color:var(--fg);font-size:13px;font-family:inherit;outline:none;width:230px;transition:.16s;
  }
  .search:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}

  /* 表格 */
  .tw{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{
    text-align:left;padding:9px 12px;font-size:11.5px;font-weight:600;color:var(--muted);
    letter-spacing:.4px;white-space:nowrap;background:color-mix(in srgb,var(--bg) 60%,var(--card));
    border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1;
  }
  th[data-k]{cursor:pointer;user-select:none}
  th[data-k]:hover{color:var(--accent)}
  th .arrow{opacity:.35;margin-left:3px;font-size:10px}
  th.on .arrow{opacity:1;color:var(--accent)}
  td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}
  tbody tr{transition:background .14s}
  tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
  .ta-r{text-align:right}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  code{
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
    background:var(--chip);padding:1.5px 6px;border-radius:5px;
  }
  .nm{font-weight:600;display:flex;align-items:center;gap:7px}
  .tags{margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;padding-left:15px}
  .tag{
    font-size:10.5px;padding:1px 6px;border-radius:4px;background:var(--chip);color:var(--muted);
  }
  .tag.ws{background:color-mix(in srgb,var(--accent2) 14%,transparent);color:var(--accent2)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
  .dot.ok{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 18%,transparent);animation:pulse 2.4s infinite}
  .dot.bad{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 16%,transparent)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
  .err-n{color:var(--bad);font-weight:600}
  .st-ok{color:var(--ok)} .st-err{color:var(--bad)}
  .empty{padding:26px 16px;text-align:center;color:var(--muted);font-size:13px}

  .foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:6px}
  .foot a{color:var(--accent);text-decoration:none}
  .foot a:hover{text-decoration:underline}

  /* toast */
  #toast{
    position:fixed;left:50%;bottom:26px;transform:translate(-50%,20px);opacity:0;pointer-events:none;
    background:var(--fg);color:var(--card);padding:9px 16px;border-radius:10px;font-size:13px;
    transition:.22s;box-shadow:0 8px 24px -8px rgba(0,0,0,.4);z-index:9;
  }
  #toast.show{opacity:1;transform:translate(-50%,0)}

  @media (max-width:860px){
    .cards{grid-template-columns:repeat(2,1fr)}
    .card:last-child{grid-column:span 2}
    .hide-sm{display:none}
    .search{width:100%}
    .panel-hd{flex-wrap:wrap}
    body{padding:14px 12px 32px}
  }

  /* 窄屏：表格转卡片式，免横向滑动 */
  @media (max-width:720px){
    .tw{overflow:visible;padding:0}
    table,tbody,tr,td{display:block;width:auto}
    thead{display:none}
    tbody tr{
      border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin:10px;
      background:color-mix(in srgb,var(--bg) 40%,var(--card));
    }
    tbody tr:hover{background:color-mix(in srgb,var(--accent) 6%,var(--card))}
    td{
      border:0;padding:3px 0;display:flex;align-items:center;justify-content:space-between;
      gap:14px;text-align:left !important;
    }
    td::before{
      content:attr(data-l);color:var(--muted);font-size:12px;flex:none;font-weight:500;
    }
    td.lead{display:block;padding-bottom:6px;margin-bottom:4px;border-bottom:1px dashed var(--line)}
    td.lead::before{display:none}
    td.lead .tags{margin-top:5px}
    td.num{font-variant-numeric:tabular-nums}
    td .code-wrap{text-align:right;word-break:break-all}
  }
</style></head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="logo">◈</div>
      <div>
        <h1>web-mount</h1>
        <p id="meta">加载中…</p>
      </div>
    </div>
    <div class="tools">
      <label class="tgl"><input type="checkbox" id="auto" checked><i></i><span>自动刷新</span></label>
      <button class="btn" id="btn-refresh">刷新</button>
      <button class="btn" id="btn-reload">重载配置</button>
      <button class="btn" id="btn-reset">清空统计</button>
      ${data.settings.secured ? `<a class="btn" href="${STATUS_PATH}/logout" title="退出登录">退出</a>` : ''}
    </div>
  </header>

  <section class="cards" id="cards"></section>

  <section class="panel">
    <div class="panel-hd"><span>最近 60 秒请求</span><span class="muted" id="qps">—</span></div>
    <div class="spark" id="spark"></div>
    <div class="spark-x"><span>60 秒前</span><span>30 秒前</span><span>现在</span></div>
  </section>

  <section class="panel">
    <div class="panel-hd">
      <span>路由 <b id="cnt">0</b></span>
      <input class="search" id="q" placeholder="搜索 名称 / 路径 / 端口">
    </div>
    <div class="tw">
      <table>
        <thead><tr>
          <th data-k="name">名称 / 匹配</th>
          <th data-k="target">目标</th>
          <th data-k="count" class="ta-r">请求</th>
          <th data-k="errors" class="ta-r">错误</th>
          <th data-k="lastStatus" class="ta-r">状态</th>
          <th data-k="lastMs" class="ta-r">耗时</th>
          <th data-k="lastAt" class="ta-r hide-sm">最近访问</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>

  <footer class="foot">
    <span id="foot-info"></span>
    <span>
      <a href="${STATUS_PATH}?format=json" target="_blank">JSON 接口</a>
      <span style="opacity:.4"> · </span>
      <a href="javascript:location.reload()">刷新页面</a>
    </span>
  </footer>
</div>
<div id="toast"></div>
<script>window.__WM__=${payload};window.__WM_PATH__=${JSON.stringify(STATUS_PATH)};</script>
<script>
(function(){
  'use strict';
  var PATH = window.__WM_PATH__;
  var S = window.__WM__ || { routes: [], totals: {}, traffic: [], settings: {} };
  var sortKey = '', sortDir = 1, kw = '', timer = null;

  function $(id){ return document.getElementById(id); }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function num(n){
    n = Number(n) || 0;
    if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n/1000).toFixed(1) + 'k';
    return String(n);
  }
  function pad(n){ return n < 10 ? '0' + n : String(n); }
  function time(ts){
    if (!ts) return '—';
    var d = new Date(ts);
    return pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function dur(ms){
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms/1000).toFixed(2) + 's';
  }
  function uptime(ms){
    var s = Math.floor(ms/1000);
    var d = Math.floor(s/86400); s %= 86400;
    var h = Math.floor(s/3600); s %= 3600;
    var m = Math.floor(s/60); s %= 60;
    if (d) return d + '天' + h + '小时';
    if (h) return h + '小时' + m + '分';
    if (m) return m + '分' + s + '秒';
    return s + '秒';
  }
  function toast(msg){
    var t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function(){ t.classList.remove('show'); }, 2200);
  }

  function renderCards(t){
    var items = [
      ['路由总数', num(t.routes), '', ''],
      ['后端在线', num(t.online), t.online === t.routes ? 'ok' : (t.online ? '' : 'bad'), '/' + num(t.routes)],
      ['累计请求', num(t.req), '', ''],
      ['累计错误', num(t.err), t.err ? 'bad' : '', ''],
      ['平均耗时', t.avgMs ? dur(t.avgMs) : '—', '', '']
    ];
    var h = '';
    for (var i = 0; i < items.length; i++){
      h += '<div class="card"><span>' + items[i][0] + '</span><b class="' + items[i][2] + '">' + items[i][1] + '</b>' + (items[i][3] ? '<em>' + items[i][3] + '</em>' : '') + '</div>';
    }
    $('cards').innerHTML = h;
  }

  function renderSpark(tr){
    var max = 1;
    for (var i = 0; i < tr.length; i++) if (tr[i] > max) max = tr[i];
    var now = Date.now();
    var h = '';
    for (var k = 0; k < tr.length; k++){
      var v = tr[k];
      var pct = Math.max(2, Math.round(v / max * 100));
      var d = new Date(now - (tr.length - 1 - k) * 1000);
      var label = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      h += '<div class="bar" style="height:' + pct + '%" title="' + label + ' · ' + v + ' 次"' + (v ? '' : ' data-z="1"') + '></div>';
    }
    $('spark').innerHTML = h;
    var total = 0;
    for (var j = 0; j < tr.length; j++) total += tr[j];
    $('qps').textContent = '合计 ' + total + ' 次 / 峰值 ' + max + ' 次/秒';
  }

  function filtered(){
    var list = S.routes.slice();
    if (kw){
      var k = kw.toLowerCase();
      list = list.filter(function(r){
        return (r.name + ' ' + r.matchPath + ' ' + r.matchReferer + ' ' + r.host + ':' + r.port + ' ' + r.prefix).toLowerCase().indexOf(k) >= 0;
      });
    }
    if (sortKey){
      list.sort(function(a, b){
        var x = a[sortKey], y = b[sortKey];
        if (sortKey === 'target'){ x = a.host + a.port; y = b.host + b.port; }
        if (typeof x === 'string' || typeof y === 'string'){ x = String(x || ''); y = String(y || ''); return x.localeCompare(y) * sortDir; }
        return ((x || 0) - (y || 0)) * sortDir;
      });
    }
    return list;
  }

  function renderRows(){
    var list = filtered();
    $('cnt').textContent = list.length + (list.length !== S.routes.length ? ' / ' + S.routes.length : '');
    if (!list.length){
      $('rows').innerHTML = '<tr><td colspan="7" class="empty">' + (S.routes.length ? '没有匹配的路由' : '暂无启用的路由，去 config.json 或锅巴面板添加') + '</td></tr>';
      return;
    }
    var h = '';
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      var tags = '';
      if (r.matchReferer) tags += '<span class="tag">来源 ' + esc(r.matchReferer) + '</span>';
      if (r.matchMethod) tags += '<span class="tag">' + esc(r.matchMethod) + '</span>';
      if (r.ws) tags += '<span class="tag ws">WS</span>';
      var stCls = r.lastStatus >= 400 ? 'st-err' : (r.lastStatus ? 'st-ok' : '');
      var target = esc(r.host) + ':' + esc(r.port) + (r.prefix && r.prefix !== '/' ? '<span style="opacity:.6">' + esc(r.prefix) + '</span>' : '');
      h += '<tr>' +
        '<td class="lead"><div class="nm"><span class="dot ' + (r.online ? 'ok' : 'bad') + '" title="' + (r.online ? '在线 · ' + r.ping + 'ms' : '无法连接') + '"></span>' + esc(r.name) + '</div>' +
          '<div class="tags"><code>' + esc(r.matchPath) + '</code>' + tags + '</div></td>' +
        '<td data-l="目标"><code>' + target + '</code></td>' +
        '<td class="num" data-l="请求">' + num(r.count) + '</td>' +
        '<td class="num ' + (r.errors ? 'err-n' : '') + '" data-l="错误">' + (r.errors || '—') + '</td>' +
        '<td class="num ' + stCls + '" data-l="状态">' + (r.lastStatus || '—') + '</td>' +
        '<td class="num" data-l="耗时">' + dur(r.lastMs) + '</td>' +
        '<td class="num hide-sm" data-l="最近" style="opacity:.75">' + time(r.lastAt) + '</td>' +
      '</tr>';
    }
    $('rows').innerHTML = h;
  }

  function renderMeta(){
    var st = S.settings || {};
    $('meta').textContent = S.routes.length + ' 条路由 · 运行 ' + uptime(S.uptime || 0);
    $('foot-info').innerHTML =
      '热重载 ' + (st.autoReload ? '<b style="color:var(--ok)">开启</b>' : '关闭') +
      ' · 调试日志 ' + (st.debug ? '开启' : '关闭') +
      ' · 超时 ' + (st.proxyTimeout || '-') + 'ms' +
      ' · 状态页' + (st.secured ? '已加口令' : '未设口令');
  }

  function render(d){
    S = d;
    renderMeta();
    renderCards(d.totals || {});
    renderSpark(d.traffic || []);
    renderRows();
  }

  function pull(){
    fetch(PATH + '?format=json', { headers: { 'accept': 'application/json' }, credentials: 'same-origin' })
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(render)
      .catch(function(e){ if (String(e.message) === '401') location.reload(); });
  }

  function act(path, okMsg){
    fetch(PATH + path, { method: 'POST', credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(d){ toast(d.message || okMsg); pull(); })
      .catch(function(){ toast('操作失败'); });
  }

  // 表头排序
  var ths = document.querySelectorAll('th[data-k]');
  for (var i = 0; i < ths.length; i++){
    ths[i].addEventListener('click', function(){
      var k = this.getAttribute('data-k');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      for (var j = 0; j < ths.length; j++){
        ths[j].classList.toggle('on', ths[j] === this);
        var a = ths[j].querySelector('.arrow');
        if (a) a.textContent = (ths[j] === this ? (sortDir > 0 ? '▲' : '▼') : '▲');
      }
      renderRows();
    });
  }

  $('q').addEventListener('input', function(){ kw = this.value.trim(); renderRows(); });
  $('btn-refresh').addEventListener('click', function(){ pull(); toast('已刷新'); });
  $('btn-reload').addEventListener('click', function(){ act('/reload', '已重载'); });
  $('btn-reset').addEventListener('click', function(){
    if (confirm('确定清空所有请求统计？')) act('/reset', '统计已清空');
  });

  var auto = $('auto');
  function startAuto(){
    if (timer) clearInterval(timer);
    if (auto.checked) timer = setInterval(function(){ if (!document.hidden) pull(); }, 3000);
  }
  auto.addEventListener('change', startAuto);

  render(S);
  startAuto();
})();
</script>
</body></html>`

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  /* ---------- 启动日志 ---------- */
  printRoutes() {
    const routes = state.routes
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
      logger.warn(`[web-mount] 以下 ${skipped.length} 条因端口无效被跳过: ` +
        skipped.map(r => `${r.matchPath}(port=${r.port})`).join(' ; '))
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
