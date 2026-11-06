import net from 'node:net'

/* ------------------------------------------------------------------ *
 * 运行状态与统计的单一数据源。
 * 独立状态页(index.js) 与 锅巴面板页面(guoba/index.js) 共用这里，
 * 保证两处看到的是同一份数据。
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  debug: false,
  autoReload: true,
  statusPage: true,
  statusToken: '',
  proxyTimeout: 30000,
}

// 用 globalThis 兜住「模块被重新加载」的情况，避免热重载时统计清零
const G = globalThis
if (!G.__webMountState) {
  G.__webMountState = {
    routes: [],
    displayRoutes: [],
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
export const state = G.__webMountState

export function statKey(r) {
  return `${r.matchPath}|${r.matchReferer || ''}|${r.host}:${r.port}|${r.prefix}`
}

export function statOf(r) {
  const k = statKey(r)
  let s = state.stats.get(k)
  if (!s) {
    s = { count: 0, errors: 0, lastStatus: 0, lastAt: 0, lastMs: 0 }
    state.stats.set(k, s)
  }
  return s
}

/* ---------- 后端连通性探测 ---------- */
export function probe(host, port, timeout = 800) {
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
export function touchTraffic() {
  const sec = Math.floor(Date.now() / 1000)
  state.secBuckets.set(sec, (state.secBuckets.get(sec) || 0) + 1)
  if (state.secBuckets.size > 180) {
    const cut = sec - 120
    for (const k of state.secBuckets.keys()) if (k < cut) state.secBuckets.delete(k)
  }
}

export function trafficBuckets() {
  const nowSec = Math.floor(Date.now() / 1000)
  const out = new Array(60).fill(0)
  for (let i = 0; i < 60; i++) out[i] = state.secBuckets.get(nowSec - 59 + i) || 0
  return out
}

export function resetStats() {
  state.stats.clear()
  state.secBuckets.clear()
}

/* ---------- 站点导航 ----------
 * 一个端口上可能挂着多个**不同的页面**（如 GsCore 面板 /zy 与它插件页
 * /daily-analyisis-gscore），所以不能简单地「一个后端只出一个入口」。
 *
 * 规则：
 *   entry = true   → 一定进导航，同一后端可以有多条
 *   entry = false  → 一定不进
 *   entry 缺省     → 自动补，但会跳过「已通过显式入口覆盖的同一个页面」
 *
 * 「同一个页面」= 目标根路径相同：/zy(prefix /app) 与 /app(prefix /app) 是
 * 同一个应用的两个入口，只保留一个；而 /daily-analyisis-gscore(prefix /daily-…)
 * 是另一个页面，独立成卡片。
 */
function isApiLike(r) {
  return /^\/(api|ws|socket|files|static|assets|login|signin|signout|logout|auth|oauth)\b/i.test(r.matchPath)
}

// 该路由在目标后端上的根路径，用来判断两条路由是不是「同一个页面」。
// prefix 是「目标内前缀」，所以它就是后端上的页面根；prefix 为 / 表示直接映射到后端根。
function appRoot(r) {
  const p = String(r.prefix || '/').replace(/\/+$/, '')
  return p === '' ? '/' : p
}

// 从一组里自动挑选：排除接口类路径，取最短的匹配路径
function pickAuto(group) {
  const cands = group.filter(r => !isApiLike(r))
  if (!cands.length) return null
  cands.sort((a, b) => a.matchPath.length - b.matchPath.length || a.matchPath.localeCompare(b.matchPath))
  return cands[0]
}

function toService(r) {
  return {
    key: `${r.host}:${r.port}#${r.matchPath}`,
    name: r.name || r.matchPath,
    path: r.matchPath === '/' ? '/' : r.matchPath + '/',
    matchPath: r.matchPath,
    host: r.host,
    port: r.port,
    online: !!r.online,
    ping: r.ping,
    routes: 1,
    explicit: r.entry === true,
  }
}

export function computeServices(routes) {
  const explicit = []
  const groups = new Map()

  for (const r of routes) {
    if (r.entry === true) {
      explicit.push(r)
    } else if (r.entry === false) {
      // 明确不进导航
      continue
    } else {
      const k = `${r.host}:${r.port}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
  }

  const picked = explicit.slice()

  for (const [k, group] of groups) {
    // 这台后端上已被显式指定为入口的「页面根」，其余同页面的路由不再重复出卡片
    const covered = new Set(
      explicit.filter(r => `${r.host}:${r.port}` === k).map(appRoot)
    )
    const cands = covered.size
      ? group.filter(r => !isApiLike(r) && !covered.has(appRoot(r)))
      : group
    const pick = pickAuto(cands)
    if (pick) picked.push(pick)
  }

  // 同一个页面根只保留一张卡片（显式优先，其次自动）
  const seen = new Set()
  return picked
    .filter(r => {
      const k = `${r.host}:${r.port}#${appRoot(r)}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map(toService)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/* ---------- 汇总当前状态（供两个页面取用） ---------- */
export async function collectStatus() {
  const cfg = state.settings
  const now = Date.now()

  // 展示顺序按配置里的原始顺序；匹配才用「最长路径优先」
  const list = (state.displayRoutes && state.displayRoutes.length) ? state.displayRoutes : state.routes

  // 后端探测做 4 秒缓存，避免自动刷新时反复建 TCP 连接
  if (now - state.healthAt > 4000 || state.health.size !== list.length) {
    const pinged = await Promise.all(list.map(r => probe(r.host, r.port, 700)))
    state.health = new Map(list.map((r, i) => [statKey(r), pinged[i]]))
    state.healthAt = Date.now()
  }

  const routes = list.map(r => {
    const s = statOf(r)
    const h = state.health.get(statKey(r)) || { online: false, ping: -1 }
    return {
      name: r.name, matchPath: r.matchPath, matchReferer: r.matchReferer,
      matchMethod: r.matchMethod, host: r.host, port: r.port,
      prefix: r.prefix, ws: r.ws,
      entry: r.entry,
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
      allowEmbed: cfg.allowEmbed !== false,
      configEditor: cfg.configEditor !== false,
    },
    traffic: trafficBuckets(),
    services: computeServices(routes),
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
