/**
 * 路径处理与路由匹配。
 *
 * 这里全是纯函数（不读全局状态、不发请求），因此可以直接单元测试。
 * 规则变更请同时更新 test/route.mjs —— 这一层的错误往往表现为「请求莫名
 * 打到别的后端」，从日志里很难看出来。
 */

/* ------------------------------------------------------------------ *
 * 统一路由模型：
 *   每条 route = { enable, name, matchPath, matchReferer, matchMethod, host, port, prefix, ws }
 *   - matchPath     监听/匹配的 URL 路径前缀(如 /api /login /memes)
 *   - matchReferer  来源(Referer/Origin)包含此字符串才命中，| 分隔多个，留空=不限制
 *   - matchMethod   HTTP 方法限制(GET|POST ...)，留空=不限制
 *   - 命中 = matchPath 匹配 && matchReferer 匹配 && matchMethod 匹配
 *   - 多条规则按「路径越长越优先，同长度保持配置顺序」匹配，首条命中即转发
 * ------------------------------------------------------------------ */

// 取 URL 去掉查询串后的路径
export function pathnameOf(url) {
  return (url || '').split('?')[0]
}

// 取查询串（含 ?）
export function queryOf(url) {
  return url.includes('?') ? url.slice(url.indexOf('?')) : ''
}

// 计算子路径：/api/foo 命中 /api -> '/foo'；/api 精确命中 -> ''；不命中 -> null
export function subPath(pathname, mp) {
  mp = mp || '/'
  if (mp === '/') return pathname
  if (pathname === mp) return ''
  if (pathname.startsWith(mp + '/')) return pathname.slice(mp.length)
  return null
}

// 拼接「目标内前缀 + 子路径」，避免出现 //。
// prefix 为 '/' 表示映射到后端根目录，也就是「剥掉挂载前缀」(适合配了 base path 的面板，如青龙 QlBaseUrl)
export function joinPath(prefix, sub) {
  let p = prefix || ''
  if (p !== '/') p = p.replace(/\/+$/, '')
  if (p === '/') p = ''
  let s = sub || ''
  if (s === '') return p === '' ? '/' : p
  if (!s.startsWith('/')) s = '/' + s
  return p + s
}

// 模式命中：支持 | 或 , 分隔多关键字(OR)
export function hasAny(hay, pat) {
  if (!pat) return false
  return String(pat)
    .split(/[|,]/)
    .some(p => p && hay.includes(p.trim()))
}

/* 来源分流的请求来源。三条原则：
 *  1. 只取 Referer / Origin 的 pathname —— 拿完整 URL 直接做子串匹配时，
 *     查询串里的 ?q=/zy 也会命中，属于误匹配。
 *  2. Referer 由客户端完全掌控，任意站点都能伪造。开启 refererSameOriginOnly 时，
 *     只有 host 等于本次请求 Host 的来源才参与分流；跨站来源一律走「没有来源限制」
 *     的兜底路由。这一条直接堵住「陌生网页把 /api 打到自己后端」的口子。
 *  3. 只带 Origin（没有 Referer）时，Origin 的 pathname 恒为 '/'，按路径分流必然落空
 *     （典型的：iframe 里加载的锅巴插件页、各种模块脚本）。这类请求给一个标记，
 *     由 findRoute 兜底处理，而且必须排在「只认同源兜底」的模式前面 ——
 *     对这类请求来说，'+' 比 '/' 更精确。
 */
export const ORIGIN_ONLY = '+'

export function refContext(headers, settings) {
  const raw = []
  if (headers.referer) raw.push(headers.referer)
  if (headers.origin) raw.push(headers.origin)
  const selfHost = String(headers.host || '').toLowerCase()
  const sameOriginOnly = !settings || settings.refererSameOriginOnly !== false
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
  if (!headers.referer && headers.origin) parts.push(ORIGIN_ONLY)
  return parts.join(' ')
}

// 来源里单独一项写 '/' 表示「不挑来源」（这些路由本来就是兜底用的）
export const isCatchAllReferer = s => typeof s === 'string' && s.split(/[|,]/).some(p => p.trim() === '/')

export function routeMatches(r, ref, pathname, method, viaOriginOnly = false) {
  if (subPath(pathname, r.matchPath) === null) return false
  if (r.matchReferer && !isCatchAllReferer(r.matchReferer) && !hasAny(ref, r.matchReferer)) {
    // 这次来源里没命中：仅当请求只有 Origin（拿不到页面路径）时才有资格进候选，
    // 由 rankRoutes 排到「同源兜底」之后 —— 否则还是和以前一样直接不匹配。
    if (!viaOriginOnly) return false
  }
  if (r.matchMethod && !hasAny(method, r.matchMethod.toUpperCase())) return false
  return true
}

/* 同路径多条路由时的挑选顺序：
 *   来源匹配 → 同源兜底（没写来源，或来源含 '/'） → 只带 Origin 的请求 → 配置顺序
 * 前两档保持「配置顺序」不变，只有「来源子串真命中」的才被提到最前，
 * 这样原来按顺序兜底的配置行为一模一样。
 * viaOriginOnly：这次请求只有 Origin、没有 Referer（见 ORIGIN_ONLY）。
 */
function rankRoutes(routes, ref, pathname, method) {
  // 按空格切分再比对，而不是 includes：来源 pathname 里带 '+' 时不该被当成标记
  const viaOriginOnly = ref.split(' ').includes(ORIGIN_ONLY)
  const hasRef = s => !!s && s.split(/[|,]/).some(p => p && ref.includes(p.trim()))
  // rank 越小越优先。没有来源限制（或来源里写了 '/'）的那一档本来就会匹配任意
  // 来源，所以对它来说「命不命中」没有意义，直接归到同源兜底这一档。
  const rank = r => {
    if (!r.matchReferer) return 1
    if (hasRef(r.matchReferer)) return 0
    if (isCatchAllReferer(r.matchReferer)) return 1
    return viaOriginOnly ? 2 : 3
  }
  let best
  let bestRank = 9
  for (const r of routes) {
    if (!routeMatches(r, ref, pathname, method, viaOriginOnly)) continue
    const k = rank(r)
    if (k < bestRank) {
      best = r
      bestRank = k
      if (k === 0) break
    }
  }
  return best
}

// HTTP 与 WebSocket 共用同一套匹配逻辑，避免 WS 绕过来源/方法限制
export function findRoute(routes, pathname, ref, method) {
  return rankRoutes(routes, ref, pathname, method)
}

// 最长路径优先；同长度保持配置顺序(保证 /api 按来源分流的顺序不被破坏)
export function sortRoutes(list) {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.matchPath.length - a.r.matchPath.length || a.i - b.i)
    .map(x => x.r)
}

/* ------------------------------------------------------------------ *
 * 自动派生 /api 路由
 *
 * 很多面板（GsCore、NapCat、agents…）的页面挂在 /zy、/webui 下，但页面里的
 * 前端代码是拿**绝对路径** /api/... 发请求的。这份请求到达 Yunzai 的端口时，
 * 路径已经不含挂载前缀，只能靠 Referer 认领 —— 也就是要手动再配一条
 *   matchPath=/api, matchReferer=/zy, prefix=/api
 * 每条页面各配一次，容易漏、容易写错。
 *
 * 打开路由上的 autoApi 后，这里按「同一后端」把页面路径合并成一条：
 *   /zy(autoApi) + /app(autoApi)  →  /api  来源 /zy|/app  →  同一后端
 *
 * 三条保守规则：
 *   1. 已存在手工 /api 路由的后端不再生成 —— 手工优先，避免出现两条抢同一请求；
 *   2. matchPath 为 '/' 的兜底路由不生成 —— 它的 Referer 会是任意路径，等于不设防；
 *   3. 派生路由带 derived 标记，且 entry=false，不会变成服务入口卡片。
 * ------------------------------------------------------------------ */
export function expandAutoApi(routes) {
  const manualApi = new Set()
  for (const r of routes) {
    if (!r.derived && r.matchPath === '/api') manualApi.add(`${r.host}:${r.port}`)
  }

  const groups = new Map()
  for (const r of routes) {
    if (!r.autoApi || r.derived) continue
    if (r.matchPath === '/' || r.matchPath === '/api') continue
    const k = `${r.host}:${r.port}`
    if (manualApi.has(k)) continue
    if (!groups.has(k)) groups.set(k, { host: r.host, port: r.port, refs: [], ws: false })
    const g = groups.get(k)
    if (!g.refs.includes(r.matchPath)) g.refs.push(r.matchPath)
    // 父页面开了 WS，派生出来的 /api 也允许 WS —— 否则「页面能收推送、/api 的 WS 却连不上」
    if (r.ws) g.ws = true
  }

  if (!groups.size) return routes

  const derived = []
  for (const g of groups.values()) {
    derived.push({
      enable: true,
      name: `自动 /api（${g.refs.join('|')}）`,
      matchPath: '/api',
      matchReferer: g.refs.join('|'),
      matchMethod: '',
      host: g.host,
      port: g.port,
      prefix: '/api',
      ws: g.ws,
      entry: false,
      derived: true,
    })
  }
  // 追加在末尾：sortRoutes 里同长度的按原顺序，手工 /api 因此优先于派生规则
  return routes.concat(derived)
}
