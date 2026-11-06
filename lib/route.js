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
  return String(pat).split(/[|,]/).some(p => p && hay.includes(p.trim()))
}

/* 来源分流的请求来源。两条原则：
 *  1. 只取 Referer / Origin 的 pathname —— 拿完整 URL 直接做子串匹配时，
 *     查询串里的 ?q=/zy 也会命中，属于误匹配。
 *  2. Referer 由客户端完全掌控，任意站点都能伪造。开启 refererSameOriginOnly 时，
 *     只有 host 等于本次请求 Host 的来源才参与分流；跨站来源一律走「没有来源限制」
 *     的兜底路由。这一条直接堵住「陌生网页把 /api 打到自己后端」的口子。
 */
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
  return parts.join(' ')
}

export function routeMatches(r, ref, pathname, method) {
  if (subPath(pathname, r.matchPath) === null) return false
  if (r.matchReferer && !hasAny(ref, r.matchReferer)) return false
  if (r.matchMethod && !hasAny(method, r.matchMethod.toUpperCase())) return false
  return true
}

// HTTP 与 WebSocket 共用同一套匹配逻辑，避免 WS 绕过来源/方法限制
export function findRoute(routes, pathname, ref, method) {
  return routes.find(r => routeMatches(r, ref, pathname, method))
}

// 最长路径优先；同长度保持配置顺序(保证 /api 按来源分流的顺序不被破坏)
export function sortRoutes(list) {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.matchPath.length - a.r.matchPath.length) || (a.i - b.i))
    .map(x => x.r)
}
