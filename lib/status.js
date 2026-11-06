import net from 'node:net'
import { DEFAULT_SETTINGS } from './config.js'

/* ------------------------------------------------------------------ *
 * 运行状态与统计的单一数据源。
 * 独立状态页(index.js) 与 锅巴面板页面(guoba/index.js) 共用这里，
 * 保证两处看到的是同一份数据。
 *
 * DEFAULT_SETTINGS 从 lib/config.js 引入，不再各自维护一份：
 * 之前两个文件各有一份且字段不一致（这里缺 allowEmbed/configEditor），
 * 是多个「改了 A 忘了 B」类缺陷的共同根源。
 * ------------------------------------------------------------------ */

export { DEFAULT_SETTINGS }

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
    // 我们 push 进 Bot.express.quiet 的路径（用于热重载时精确撤销，不误删别人的）
    quietPaths: [],
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
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
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
 * 「同一个页面」怎么判断（v1.5.3 修正）：
 *   - 正常映射：目标内前缀就是后端上的页面根，/zy(prefix /app) 与 /app(prefix /app)
 *     是同一个应用，只留一张卡。
 *   - 剥离前缀(prefix = '/')：这个值不携带任何页面信息 —— 青龙、NapCat、agents
 *     这类服务全都填 '/'，但它们的页面各不相同。此时必须退化成用 matchPath
 *     当页面标识，否则同一端口上的多个页面会被判成同一个而整片消失，
 *     不同端口之间也会互相「覆盖」。
 */
function isApiLike(r) {
  return /^\/(api|ws|socket|files|static|assets|login|signin|signout|logout|auth|oauth)\b/i.test(r.matchPath)
}

// 判断「这两条路由是不是同一个页面」：
// 同一个后端根目录('/')上可以挂多个页面 —— prefix='/' 只说明「剥掉挂载前缀映射到后端根」，
// 所以 /ncqq -> /、/agents(不同端口) -> / 各自独立，/ncqq 与 /webui 也是两个页面。
// 因此两侧都是「后端根」时必须再看 matchPath，否则会让一个页面把另一个页面顶掉。
function pageKey(r) {
  const p = String(r.prefix || '/').replace(/\/+$/, '')
  if (p === '') return `${r.matchPath}#root`
  return p
}

// 从一组里自动挑选一个候选：排除接口类路径与已被显式入口覆盖的页面，取最短的匹配路径
function pickAuto(group, covered = new Set()) {
  const cands = group.filter(r => !isApiLike(r) && !covered.has(pageKey(r)))
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
    const covered = new Set(explicit.filter(r => `${r.host}:${r.port}` === k).map(pageKey))

    // 分两组：
    //   裸根组 —— prefix='/' 的「剥离挂载前缀」路由。它们全指向后端根目录，
    //             默认只出一张卡（否则 /qinglong、/ncqq 会各冒一张，而 NapCat 的
    //             真正页面是 /webui）；但一旦这张卡给它了，同端口其它根路径页面
    //             不能再被它顶掉。
    //   具名组 —— prefix 指向具体子路径的路由，按 pageKey（=prefix）各出一张。
    //            /app(prefix /app) 与 /zy(prefix /app) 是同一个应用，只留一张；
    //            /webui(prefix /webui) 与 /ncqq(prefix /) 是两个页面，各留一张。
    //
    // v1.5.3 之前把这两组混在一起，用 prefix 做键，导致 prefix='/' 的路由
    // 在「去重」阶段吃掉同端口所有其它页面（NapCat WebUI 卡片消失就是这个原因）。
    const bareRoot = []
    const named = new Map()
    for (const r of group) {
      const key = pageKey(r)
      if (key.endsWith('#root')) bareRoot.push(r)
      else {
        if (!named.has(key)) named.set(key, [])
        named.get(key).push(r)
      }
    }

    for (const [key, list] of named) {
      if (covered.has(key)) continue
      const pick = pickAuto(list, covered)
      if (pick) picked.push(pick)
    }

    if (bareRoot.length && !bareRoot.some(r => covered.has(pageKey(r)))) {
      const pick = pickAuto(bareRoot, covered)
      if (pick) picked.push(pick)
    }
  }

  // 同一后端上的同一个页面只保留一张卡片（显式优先，其次自动）。
  // 具有 entry=true 的路由排前面，保证去重时不会被自动挑中的同页面路由顶掉。
  const seen = new Set()
  return picked
    .slice()
    .sort((a, b) => Number(b.entry === true) - Number(a.entry === true))
    .filter(r => {
      const k = `${r.host}:${r.port}#${pageKey(r)}`
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
  const list = state.displayRoutes && state.displayRoutes.length ? state.displayRoutes : state.routes

  // 后端探测做 4 秒缓存，避免自动刷新时反复建 TCP 连接。
  // 按 host:port 去重：一个后端常被 3~5 条路由共用（页面 + 资源 + 接口），
  // 逐条探测等于同一个端口反复建连，在 Termux/手机上尤其浪费。
  if (now - state.healthAt > 4000 || state.health.size !== list.length) {
    const targets = [...new Set(list.map(r => `${r.host}:${r.port}`))]
    const pings = await Promise.all(
      targets.map(t => {
        const i = t.lastIndexOf(':')
        return probe(t.slice(0, i), Number(t.slice(i + 1)), 700)
      }),
    )
    const byTarget = new Map(targets.map((t, i) => [t, pings[i]]))
    state.health = new Map(
      list.map(r => [statKey(r), byTarget.get(`${r.host}:${r.port}`) || { online: false, ping: -1 }]),
    )
    state.healthAt = Date.now()
  }

  const routes = list.map(r => {
    const s = statOf(r)
    const h = state.health.get(statKey(r)) || { online: false, ping: -1 }
    return {
      name: r.name,
      matchPath: r.matchPath,
      matchReferer: r.matchReferer,
      matchMethod: r.matchMethod,
      host: r.host,
      port: r.port,
      prefix: r.prefix,
      ws: r.ws,
      entry: r.entry,
      // 由 autoApi 自动派生的 /api 分流：展示上要区分，否则用户会以为自己配了这条
      auto: !!r.derived,
      online: !!h.online,
      ping: h.ping,
      count: s.count,
      errors: s.errors,
      lastStatus: s.lastStatus,
      lastAt: s.lastAt,
      lastMs: s.lastMs,
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
      quietProxyLog: cfg.quietProxyLog !== false,
    },
    traffic: trafficBuckets(),
    services: computeServices(routes),
    totals: {
      routes: routes.length,
      auto: routes.filter(r => r.auto).length,
      online: routes.filter(r => r.online).length,
      req: routes.reduce((a, b) => a + b.count, 0),
      err: routes.reduce((a, b) => a + b.errors, 0),
      avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    },
    routes,
  }
}
