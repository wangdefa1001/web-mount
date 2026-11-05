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

/* ---------- 站点导航：把同一后端的多条路由聚成一个入口 ---------- */
function pickEntry(group) {
  const explicit = group.find(r => r.entry === true)
  if (explicit) return explicit
  // 自动挑选：排除纯接口类路径，取最短的匹配路径作为入口。
  // 注意 ws:true 只表示「这条路由还要转发 WebSocket」，不代表它不是页面（如 /webui），不能据此排除。
  const cands = group.filter(r =>
    r.entry !== false && !/^\/(api|ws|socket|files|static)\b/i.test(r.matchPath)
  )
  if (!cands.length) return null
  cands.sort((a, b) => a.matchPath.length - b.matchPath.length || a.matchPath.localeCompare(b.matchPath))
  return cands[0]
}

export function computeServices(routes) {
  const groups = new Map()
  for (const r of routes) {
    const k = `${r.host}:${r.port}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const out = []
  for (const [key, group] of groups) {
    const entry = pickEntry(group)
    if (!entry) continue
    out.push({
      key,
      name: entry.name || entry.matchPath,
      path: entry.matchPath === '/' ? '/' : entry.matchPath + '/',
      matchPath: entry.matchPath,
      host: entry.host,
      port: entry.port,
      online: !!entry.online,
      ping: entry.ping,
      routes: group.length,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return out
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
