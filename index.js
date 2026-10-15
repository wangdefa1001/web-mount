import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import plugin from '../../lib/plugins/plugin.js'

/* ------------------------------------------------------------------ *
 * 统一路由模型：
 *   每条 route = { enable, name, matchPath, matchReferer, host, port, prefix, ws }
 *   - matchPath    监听/匹配的 URL 路径前缀(如 /api /login /memes)
 *   - matchReferer 来源(Referer/Origin)包含此字符串才命中，| 分隔多个，留空=不限制
 *   - 命中 = matchPath 匹配 && matchReferer 匹配；多条按数组顺序匹配，首条命中即转发
 *   - 同一 matchPath 可出现多条(如 /api 按来源分给 GsCore/NapCat/青龙)，靠顺序+来源区分
 * ------------------------------------------------------------------ */

const configDir = path.join(process.cwd(), 'plugins/web-mount/config')
const configPath = path.join(configDir, 'config.json')
const defaultConfigPath = path.join(configDir, 'default_config.json')

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
// 计算子路径：/api/foo 命中 /api -> '/foo'；/api 精确命中 -> ''；不命中 -> null
function subPath(pathname, mp) {
  mp = mp || '/'
  if (mp === '/') return pathname
  if (pathname === mp) return ''
  if (pathname.startsWith(mp + '/')) return pathname.slice(mp.length)
  return null
}
// 模式命中：支持 | 分隔多关键字(OR)
function hasAny(hay, pat) {
  if (!pat) return false
  return pat.split('|').some(p => p && hay.includes(p))
}
function routeMatches(r, ref, pathname) {
  if (subPath(pathname, r.matchPath) === null) return false
  if (r.matchReferer && !hasAny(ref, r.matchReferer)) return false
  return true
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

function loadConfig() {
  ensureConfig()
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')))
  } catch {
    return { routes: [] }
  }
}

function normalizeRoute(r) {
  const matchPath = normPath(r && r.matchPath) || '/'
  return {
    enable: !!r.enable,
    name: normStr(r.name) || (matchPath + (r.matchReferer ? ' [' + normStr(r.matchReferer) + ']' : '')),
    matchPath,
    matchReferer: normStr(r.matchReferer),
    host: normStr(r.host) || '127.0.0.1',
    port: normPort(r.port),
    prefix: normPath(r.prefix) || '/',
    ws: !!r.ws,
  }
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { routes: [] }

  // 新格式：routes 数组优先
  if (Array.isArray(raw.routes)) {
    return { routes: raw.routes.map(normalizeRoute).filter(r => r.port) }
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
  return { routes: routes.filter(r => r.port) }
}

/* ------------------------------------------------------------------ *
 * 主插件
 * ------------------------------------------------------------------ */
export default class WebMount extends plugin {
  constructor() {
    super({ name: 'web-mount' })
  }

  async init() {
    if (!Bot.express || !Bot.server) return false
    const cfg = loadConfig()
    const routes = (cfg.routes || []).filter(r => r.enable)

    // 数据校验：端口无效 / 路径缺失的进入失败清单
    const failed = []
    const valid = []
    for (const r of routes) {
      if (!r.port) { failed.push(`${r.matchPath}${r.matchReferer ? '(' + r.matchReferer + ')' : ''}(端口无效)`); continue }
      valid.push(r)
    }

    // ---------- 1) HTTP 转发：单一全局中间件，按规则匹配 ----------
    try {
      Bot.express.use((req, res, next) => {
        const url = req.originalUrl || req.url || '/'
        const ref = (req.headers.referer || '') + (req.headers.origin || '')
        const pathname = pathnameOf(url)
        // 先快速过滤：没有任何规则命中该路径则直接放行
        const hasRoute = valid.some(r => subPath(pathname, r.matchPath) !== null)
        if (!hasRoute) return next()

        const route = valid.find(r => routeMatches(r, ref, pathname))
        if (!route) return next()

        // 纯挂载(无来源限制)的精确 GET 请求：规范为带斜杠，避免相对资源错位
        if (!route.matchReferer && req.method === 'GET' && route.matchPath !== '/' && pathname === route.matchPath) {
          return res.redirect(route.matchPath + '/')
        }

        const sub = subPath(pathname, route.matchPath)
        const qs = url.includes('?') ? url.slice(url.indexOf('?')) : ''
        const proxyPath = route.prefix + (sub || '') + qs
        this.forward(req, res, proxyPath, { host: route.host, port: route.port })
      })
    } catch (e) {
      logger.error('[web-mount] HTTP 中间件注册失败: ' + e.message)
    }

    // ---------- 2) WebSocket 转发：统一 upgrade 监听 ----------
    const wsRoutes = valid.filter(r => r.ws)
    if (wsRoutes.length) {
      try {
        Bot.server.prependListener('upgrade', (req, socket, head) => {
          const pathname = pathnameOf(req.url || '')
          for (const r of wsRoutes) {
            const sub = subPath(pathname, r.matchPath)
            if (sub === null) continue
            const qs = (req.url || '').includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
            this.forwardWs(req, socket, head, r.prefix + sub + qs, { host: r.host, port: r.port })
            return
          }
        })
      } catch (e) {
        logger.error('[web-mount] WS 监听注册失败: ' + e.message)
      }
    }

    // ---------- 3) 启动日志：逐条列出实际挂载的路由 ----------
    for (const r of valid) {
      const src = r.matchReferer ? `(来源 ${r.matchReferer})` : ''
      const prefixTxt = r.prefix && r.prefix !== '/' ? r.prefix : ''
      logger.mark(
        `[web-mount] ${r.matchPath}${src} -> ${r.host}:${r.port}${prefixTxt} 已挂载${r.ws ? '(含WS)' : ''}${r.name ? ' [' + r.name + ']' : ''}`
      )
    }
    if (valid.length) {
      const list = valid.map(r => r.matchPath + (r.matchReferer ? `<${r.matchReferer}>` : '')).join(' ')
      logger.mark(`[web-mount] 启动完成，已挂载 ${valid.length} 条: ${list}`)
    }
    if (failed.length) {
      logger.warn(`[web-mount] 以下 ${failed.length} 条被跳过: ${failed.join(' ; ')}`)
    }

    return true
  }

  /* HTTP 反向代理 */
  forward(req, res, proxyPath, target) {
    const headers = { ...req.headers }
    delete headers.host
    headers.host = `${target.host}:${target.port}`
    headers['x-forwarded-for'] = req.socket?.remoteAddress || headers['x-forwarded-for'] || ''
    headers['x-forwarded-host'] = headers.host
    headers['x-forwarded-proto'] = req.socket?.encrypted ? 'https' : 'http'

    // 判断 body 是否已被 body-parser 消费：存在 req.body 用解析结果，否则走原始流管道
    let bodyData = null
    if (req.body !== undefined && req.body !== null) {
      bodyData = this.bodyToBuffer(req.body)
      if (bodyData && !headers['content-type'] && req.body && typeof req.body === 'object') {
        headers['content-type'] = 'application/json'
      }
    }
    if (bodyData) headers['content-length'] = bodyData.length
    else delete headers['content-length']

    const proxyReq = http.request(
      { host: target.host, port: target.port, path: proxyPath || '/', method: req.method, headers },
      pRes => {
        res.writeHead(pRes.statusCode, pRes.headers)
        pRes.pipe(res, { end: true })
      }
    )
    proxyReq.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('proxy unreachable: ' + err.message)
    })

    if (bodyData) {
      proxyReq.write(bodyData)
      proxyReq.end()
    } else {
      req.pipe(proxyReq, { end: true })
    }
  }

  bodyToBuffer(body) {
    if (body === undefined || body === null) return null
    if (Buffer.isBuffer(body)) return body.length ? body : null
    if (typeof body === 'string') return body.length ? Buffer.from(body, 'utf8') : null
    if (typeof body === 'object') {
      const s = body && body.constructor === Object ? JSON.stringify(body) : String(body)
      if (!s || s === '{}' || s === '[]') return null
      return Buffer.from(s, 'utf8')
    }
    return null
  }

  /* WebSocket 反向代理 */
  forwardWs(req, socket, head, targetPath, target) {
    const headers = { ...req.headers }
    delete headers.host
    headers.host = `${target.host}:${target.port}`

    const proxy = http.request({
      host: target.host,
      port: target.port,
      path: targetPath || '/',
      method: req.method,
      headers,
    })
    proxy.on('upgrade', (pRes, pSocket, pHead) => {
      let raw = `HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage}\r\n`
      for (const k in pRes.headers) raw += `${k}: ${pRes.headers[k]}\r\n`
      raw += '\r\n'
      socket.write(raw)
      if (pHead && pHead.length) socket.write(pHead)
      pSocket.pipe(socket)
      socket.pipe(pSocket)
    })
    proxy.on('response', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    proxy.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    proxy.end()
  }
}
