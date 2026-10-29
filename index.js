import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
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
function checkHealth(host, port, timeout = 800) {
  return new Promise(resolve => {
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
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
    if (cfg.statusPage && pathname.replace(/\/+$/, '') === STATUS_PATH) {
      if (cfg.statusToken) {
        const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
        if (q.get('token') !== cfg.statusToken) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('web-mount: 需要口令，请访问 ' + STATUS_PATH + '?token=你的statusToken')
        }
      }
      return this.renderStatus(req, res, url)
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
  async renderStatus(req, res, url) {
    const wantJson = /[?&]format=json\b/.test(url)
    const rows = await Promise.all(state.routes.map(async r => {
      const s = statOf(r)
      return {
        ...r,
        online: await checkHealth(r.host, r.port, 800),
        count: s.count,
        errors: s.errors,
        lastStatus: s.lastStatus,
        lastAt: s.lastAt,
        lastMs: s.lastMs,
      }
    }))

    if (wantJson) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ settings: state.settings, routes: rows }, null, 2))
    }

    const totalReq = rows.reduce((a, b) => a + b.count, 0)
    const totalErr = rows.reduce((a, b) => a + b.errors, 0)
    const onlineCount = rows.filter(r => r.online).length

    const trs = rows.map(r => `
      <tr>
        <td><span class="dot ${r.online ? 'ok' : 'bad'}"></span>${esc(r.name)}</td>
        <td><code>${esc(r.matchPath)}</code>${r.matchReferer ? `<div class="sub">来源 ${esc(r.matchReferer)}</div>` : ''}${r.matchMethod ? `<div class="sub">方法 ${esc(r.matchMethod)}</div>` : ''}</td>
        <td><code>${esc(r.host)}:${esc(r.port)}${r.prefix !== '/' ? esc(r.prefix) : ''}</code></td>
        <td>${r.ws ? 'WS' : '-'}</td>
        <td class="num">${r.count}</td>
        <td class="num ${r.errors ? 'bad-text' : ''}">${r.errors}</td>
        <td class="num">${r.lastStatus || '-'}</td>
        <td class="num">${r.lastMs ? r.lastMs + 'ms' : '-'}</td>
        <td class="sub">${fmtTime(r.lastAt)}</td>
      </tr>`).join('')

    const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>web-mount 状态</title>
<style>
  :root{--bg:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--card:#f9fafb;--ok:#16a34a;--bad:#dc2626;--accent:#2563eb}
  @media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--card:#161b22;--ok:#3fb950;--bad:#f85149;--accent:#58a6ff}}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  h1{margin:0 0 4px;font-size:20px}
  .meta{color:var(--muted);font-size:13px;margin-bottom:18px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:96px}
  .card b{display:block;font-size:20px}
  .card span{color:var(--muted);font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .sub{color:var(--muted);font-size:11.5px;margin-top:2px}
  .bad-text{color:var(--bad)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
  .tip{margin-top:16px;color:var(--muted);font-size:12px}
  a{color:var(--accent)}
</style></head><body>
<h1>web-mount</h1>
<div class="meta">反向代理挂载状态 · ${esc(rows.length)} 条路由 · 桌面端/移动端自适应</div>
<div class="cards">
  <div class="card"><b>${rows.length}</b><span>路由总数</span></div>
  <div class="card"><b style="color:var(--ok)">${onlineCount}</b><span>后端在线</span></div>
  <div class="card"><b>${totalReq}</b><span>累计请求</span></div>
  <div class="card"><b style="color:${totalErr ? 'var(--bad)' : 'inherit'}">${totalErr}</b><span>累计错误</span></div>
  <div class="card"><b>${state.settings.proxyTimeout}ms</b><span>超时</span></div>
</div>
<table>
<thead><tr><th>名称</th><th>匹配</th><th>目标</th><th>WS</th><th>请求</th><th>错误</th><th>状态码</th><th>耗时</th><th>最近访问</th></tr></thead>
<tbody>${trs || '<tr><td colspan="9" style="color:var(--muted)">暂无启用的路由</td></tr>'}</tbody>
</table>
<div class="tip">
  热重载：${state.settings.autoReload ? '已开启（修改 config.json 后约 2 秒自动生效）' : '已关闭'} ·
  调试日志：${state.settings.debug ? '已开启' : '已关闭'} ·
  <a href="${STATUS_PATH}">刷新</a> · <a href="${STATUS_PATH}?format=json">JSON</a>
</div>
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
      logger.mark(`[web-mount] 状态页: ${STATUS_PATH}${state.settings.statusToken ? '?token=***' : ''}（后端在线情况/请求统计）`)
    }
    if (state.settings.autoReload) {
      logger.mark('[web-mount] 已开启配置热重载，修改 config.json 后约 2 秒自动生效')
    }
  }
}
