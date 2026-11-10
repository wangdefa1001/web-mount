/**
 * lib/route.js 的单元测试：纯函数，不需要起服务、不需要 Yunzai。
 * 这一层是「请求打到哪个后端」的唯一决策点，改错了现象很隐蔽，所以单独覆盖。
 */
import {
  pathnameOf,
  queryOf,
  subPath,
  joinPath,
  hasAny,
  refContext,
  routeMatches,
  findRoute,
  sortRoutes,
  expandAutoApi,
  ORIGIN_ONLY,
} from '../lib/route.js'
import { makeChecker } from './sandbox.mjs'

const check = makeChecker()

/* ---------- 路径工具 ---------- */
check('pathnameOf 去掉查询串', pathnameOf('/a/b?x=1') === '/a/b', pathnameOf('/a/b?x=1'), '/a/b')
check('pathnameOf 容忍空值', pathnameOf(undefined) === '', pathnameOf(undefined), '')
check('queryOf 带 ?', queryOf('/a?x=1') === '?x=1', queryOf('/a?x=1'), '?x=1')
check('queryOf 无查询串返回空', queryOf('/a') === '', queryOf('/a'), '')

check('subPath 前缀命中', subPath('/api/foo', '/api') === '/foo', subPath('/api/foo', '/api'), '/foo')
check('subPath 精确命中返回空串', subPath('/api', '/api') === '', subPath('/api'), '')
check('subPath 不做「假前缀」匹配', subPath('/apix', '/api') === null, subPath('/apix', '/api'), null)
check('subPath 匹配路径为 / 时原样返回', subPath('/anything', '/') === '/anything', subPath('/anything', '/'))

check('joinPath 剥离前缀', joinPath('/', '/a') === '/a', joinPath('/', '/a'), '/a')
check('joinPath 空子路径落到前缀', joinPath('/app', '') === '/app', joinPath('/app', ''), '/app')
check('joinPath 拼普通前缀', joinPath('/app', '/x') === '/app/x', joinPath('/app', '/x'), '/app/x')
check('joinPath 去掉前缀尾斜杠', joinPath('/app/', '/x') === '/app/x', joinPath('/app/', '/x'), '/app/x')
check('joinPath 根 + 空 = /', joinPath('/', '') === '/', joinPath('/'), '/')
check('joinPath 不会产生 //', joinPath('', '/x') === '/x', joinPath('', '/x'), '/x')

check('hasAny 竖线分隔', hasAny('/zy /app', '/zy|/app') === true, true, true)
check('hasAny 逗号分隔', hasAny('abc', 'x,abc') === true, true, true)
check('hasAny 空模式不命中', hasAny('abc', '') === false, hasAny('abc', ''), false)
check('hasAny 忽略空段', hasAny('abc', '|,abc,') === true, true, true)

/* ---------- 来源上下文 ---------- */
const H = (o = {}) => ({ host: 'local:2536', ...o })

// 同源：Referer 的 host 与本次请求 Host 一致 → 取 pathname
check(
  '同源 Referer 取 pathname',
  refContext(H({ referer: 'http://local:2536/zy/page?a=1' }), {}) === '/zy/page',
  refContext(H({ referer: 'http://local:2536/zy/page?a=1' }), {}),
  '/zy/page',
)

// 跨站：默认必须被剔除（防伪造）
check(
  '跨站 Referer 默认被剔除',
  refContext(H({ referer: 'http://evil.com/zy' }), {}) === '',
  refContext(H({ referer: 'http://evil.com/zy' }), {}),
  '',
)

// 显式关掉同源限制 → 保留（兼容旧行为）
check(
  '关闭同源限制后跨站也参与比对',
  refContext(H({ referer: 'http://evil.com/zy' }), { refererSameOriginOnly: false }) === '/zy',
  refContext(H({ referer: 'http://evil.com/zy' }), { refererSameOriginOnly: false }),
  '/zy',
)

// 查询串不能当来源路径（旧实现的误匹配）
check(
  '查询串里的关键字不参与匹配',
  refContext(H({ referer: 'http://local:2536/?q=/zy' }), {}) === '/',
  refContext(H({ referer: 'http://local:2536/?q=/zy' }), {}),
  '/',
)

// 畸形/相对值：没有 host，按原文路径参与
check(
  '畸形 Referer 退化为路径字符串',
  refContext(H({ referer: '/webui/index.html' }), {}) === '/webui/index.html',
  refContext(H({ referer: '/webui/index.html' }), {}),
  '/webui/index.html',
)

// Origin 与 Referer 同时存在时都要参与
check(
  'Referer 与 Origin 合并',
  refContext(H({ referer: 'http://local:2536/zy', origin: 'http://local:2536' }), {}) === '/zy /',
  refContext(H({ referer: 'http://local:2536/zy', origin: 'http://local:2536' }), {}),
  '/zy /',
)

/* ---------- 单条路由匹配 ---------- */
const R = o => ({
  enable: true,
  matchPath: '/api',
  matchReferer: '',
  matchMethod: '',
  host: 'h',
  port: 1,
  prefix: '/api',
  ...o,
})

check('匹配：路径命中即通过', routeMatches(R(), '', '/api/x', 'GET') === true, true, true)
check(
  '不匹配：路径不命中',
  routeMatches(R(), '', '/apix', 'GET') === false,
  routeMatches(R(), '', '/apix', 'GET'),
  false,
)
check('不匹配：方法受限', routeMatches(R({ matchMethod: 'POST' }), '', '/api', 'GET') === false, false, false)
check('匹配：方法相符', routeMatches(R({ matchMethod: 'POST' }), '', '/api', 'POST') === true, true, true)
check('不匹配：来源受限', routeMatches(R({ matchReferer: '/zy' }), '/app', '/api', 'GET') === false, false, false)
check('匹配：来源相符', routeMatches(R({ matchReferer: '/zy' }), '/zy', '/api', 'GET') === true, true, true)
check('方法限制大小写不敏感', routeMatches(R({ matchMethod: 'post' }), '', '/api', 'POST') === true, true, true)

/* ---------- 排序与查找 ---------- */
const sorted = sortRoutes([
  { matchPath: '/', name: 'root' },
  { matchPath: '/api', name: 'a' },
  { matchPath: '/api/user', name: 'b' },
  { matchPath: '/api', name: 'c' },
])
check(
  '最长路径优先',
  sorted.map(r => r.name).join(',') === 'b,a,c,root',
  sorted.map(r => r.name),
  ['b', 'a', 'c', 'root'],
)
check(
  '同长度保持配置顺序',
  sorted
    .filter(r => r.matchPath === '/api')
    .map(r => r.name)
    .join(',') === 'a,c',
  sorted.filter(r => r.matchPath === '/api').map(r => r.name),
  ['a', 'c'],
)

// 用户真实配置里的三个 /api 分流
const apiRoutes = sortRoutes([
  { matchPath: '/api', matchReferer: '/zy|/app|/daily-analyisis-gscore', name: 'GsCore', port: 8765 },
  { matchPath: '/api', matchReferer: '/webui|/ncqq', name: 'NapCat', port: 6099 },
  { matchPath: '/api', matchReferer: '/agents', name: 'agents', port: 6098 },
])
const pick = (ref, method = 'GET') => {
  const r = findRoute(apiRoutes, '/api/x', ref, method)
  return r ? r.name : null
}
check('/api 分流：/zy 来源 → GsCore', pick('/zy') === 'GsCore', pick('/zy'), 'GsCore')
check('/api 分流：/ncqq 来源 → NapCat', pick('/ncqq') === 'NapCat', pick('/ncqq'), 'NapCat')
check('/api 分流：/agents 来源 → agents', pick('/agents') === 'agents', pick('/agents'), 'agents')
check('/api 分流：无来源 → 不命中（交给 Yunzai）', pick('') === null, pick(''), null)

// 最长优先：/api/user 不能被 /api 抢走
const nested = sortRoutes([
  { matchPath: '/api', name: 'api', port: 1 },
  { matchPath: '/api/user', name: 'user', port: 2 },
])
check(
  '/api/user 命中更具体的那条',
  findRoute(nested, '/api/user/1', '', 'GET').name === 'user',
  findRoute(nested, '/api/user/1', '', 'GET').name,
  'user',
)

check('空路由表返回 undefined', findRoute([], '/x', '', 'GET') === undefined, findRoute([], '/x', '', 'GET'), undefined)

/* ---------- 自动派生 /api ---------- */
const page = o => ({ enable: true, matchPath: '/zy', matchReferer: '', host: 'h', port: 8765, prefix: '/app', ...o })
const derivedOf = list => expandAutoApi(list).filter(r => r.derived)

{
  const d = derivedOf([page({ autoApi: true })])
  check(
    '开启 autoApi 生成一条 /api',
    d.length === 1 && d[0].matchPath === '/api',
    d.map(x => x.matchPath),
    ['/api'],
  )
  check('派生路由的来源是页面路径', d[0].matchReferer === '/zy', d[0].matchReferer, '/zy')
  check('派生路由前缀是 /api', d[0].prefix === '/api', d[0].prefix, '/api')
  check('派生路由进同一后端', d[0].host === 'h' && d[0].port === 8765, [d[0].host, d[0].port], ['h', 8765])
  check('派生路由不成为服务入口', d[0].entry === false, d[0].entry, false)
}

{
  const d = derivedOf([page({ autoApi: true }), page({ matchPath: '/app', autoApi: true })])
  check('同端口多页面合并成一条', d.length === 1, d.length, 1)
  check('合并后来源是多个路径', d[0].matchReferer === '/zy|/app', d[0].matchReferer, '/zy|/app')
}

{
  const d = derivedOf([
    page({ autoApi: true }),
    page({ matchPath: '/webui', port: 6099, prefix: '/webui', autoApi: true }),
  ])
  check('不同端口各自派生', d.length === 2, d.length, 2)
}

{
  const d = derivedOf([page({ autoApi: true }), page({ matchPath: '/api', prefix: '/api', matchReferer: '/zy' })])
  check('已手工配 /api 的后端不再派生', d.length === 0, d.length, 0)
}

{
  const d = derivedOf([
    page({ matchPath: '/api', prefix: '/api' }), // 手工 /api 在 8765
    page({ matchPath: '/webui', port: 6099, prefix: '/webui', autoApi: true }), // 页面在 6099
  ])
  check(
    '手工 /api 只影响同一后端',
    d.length === 1 && d[0].port === 6099,
    d.map(x => x.port),
    [6099],
  )
}

{
  const d = derivedOf([page({ matchPath: '/', autoApi: true })])
  check('根挂载不派生（来源无法区分）', d.length === 0, d.length, 0)
}

{
  const d = derivedOf([page({ autoApi: false })])
  check('未开启 autoApi 不派生', d.length === 0, d.length, 0)
}

{
  const input = [page({ autoApi: true }), page({ matchPath: '/other', port: 7000 })]
  const out = expandAutoApi(input)
  check(
    '原有路由顺序不变，派生追加在末尾',
    out.slice(0, 2).every((r, i) => r === input[i]) && out[2].derived === true,
    out.map(r => r.matchPath),
    ['/zy', '/other', '/api'],
  )
}

{
  // 手工 /api 与派生 /api 共存时，靠来源各自分流，互不抢
  const sorted = sortRoutes(
    expandAutoApi([
      page({ matchPath: '/api', prefix: '/api', matchReferer: '/manual' }),
      page({ matchPath: '/qb', port: 6099, prefix: '/qb', autoApi: true }),
    ]),
  )
  const pickPort = ref => {
    const r = findRoute(sorted, '/api/x', ref)
    return r ? r.port : null
  }
  check('手工 /api 按来源命中', pickPort('/manual') === 8765, pickPort('/manual'), 8765)
  check('派生 /api 按来源命中', pickPort('/qb') === 6099, pickPort('/qb'), 6099)
  check('都不匹配时不转发', pickPort('/nope') === null, pickPort('/nope'), null)
}

/* ---------- 多 /api 按来源挑路由：同源兜底不能被「顺序」坑掉 ---------- *
 * 真实踩坑：用户既有 GsCore 的 /api（来源 /zy|/app），又有 NapCat 派生的 /api
 * （来源 /webui|/ncqq）。iframed 的锅巴插件页发请求时浏览器只带 Origin、
 * 不带 Referer（模块脚本 cross-origin 请求也不带），于是：
 *   - 旧实现：来源上下文只有 '/'，两条都不匹配 → 请求漏回 Yunzai → 404；
 *   - 且 GsCore 那条排在前面，就算放宽成「兜底优先」，锅巴的请求也会被送去 GsCore。
 */
{
  const list = sortRoutes(
    expandAutoApi([
      R({ matchReferer: '/zy|/app', port: 8765, name: 'GsCore API' }),
      page({ matchPath: '/qb', port: 6099, prefix: '/qb', autoApi: true }),
    ]),
  )
  const pick = (ref, viaOrigin) => {
    let ctx = ref
    if (viaOrigin) ctx = ref ? ref + ' ' + ORIGIN_ONLY : ORIGIN_ONLY
    const r = findRoute(list, '/api/x', ctx, 'GET')
    return r ? r.port : null
  }
  check('多 /api：来源 /zy 命中第一条', pick('/zy/page') === 8765, pick('/zy/page'), 8765)
  check('多 /api：来源 /qb 命中 NapCat', pick('/qb/index') === 6099, pick('/qb/index'), 6099)
  // 浏览器只带 Origin、不带 Referer 时（iframe 里的锅巴插件页、模块脚本即如此），
  // 以前来源上下文只有 '/'，两条受限路由都不匹配 -> 请求漏回 Yunzai -> 404
  // 只有 Origin、没有 Referer：来源上下文里只剩 '/' 和命中标记 '+'
  const pickOriginOnly = routes => {
    const r = findRoute(routes, '/api/x', '/ ' + ORIGIN_ONLY, 'GET')
    return r ? r.port : null
  }
  const l3 = sortRoutes(
    expandAutoApi([
      page({ matchPath: '/qb', port: 6099, prefix: '/qb', autoApi: true }),
      R({ matchReferer: '/zy|/app', port: 8765, name: 'GsCore API' }),
    ]),
  )
  check(
    '多 /api：只有 Origin 没 Referer 时不再整条漏回 Yunzai（会被转给其中一条）',
    pickOriginOnly(l3) === 8765,
    pickOriginOnly(l3),
    8765,
  )

  check(
    '多 /api：只有 Origin 的请求不该抢走「不设来源限制」的那一条',
    (() => {
      const l2 = sortRoutes(
        expandAutoApi([
          page({ matchPath: '/qb', port: 6099, prefix: '/qb', autoApi: true }),
          R({ matchReferer: '', port: 8765, name: '不设防 API' }),
        ]),
      )
      const r = findRoute(l2, '/api/x', '/' + ' ' + ORIGIN_ONLY, 'GET')
      return r ? r.port : null
    })() === 8765,
    '不设防 API',
    8765,
  )
  // 反向：NapCat 在前也不能抢走 GsCore 的兜底
  const flipped = sortRoutes(
    expandAutoApi([
      page({ matchPath: '/qb', port: 6099, prefix: '/qb', autoApi: true }),
      R({ matchReferer: '/zy|/app', port: 8765, name: 'GsCore API' }),
    ]),
  )
  const pick2 = ref => {
    const r = findRoute(flipped, '/api/x', ref, 'GET')
    return r ? r.port : null
  }
  check('多 /api：/zy 的请求不管配置顺序都去 GsCore', pick2('/zy') === 8765, pick2('/zy'), 8765)
  check(
    '多 /api：来源子串命中优先于同源兜底（哪怕兜底排在前面）',
    findRoute(flipped, '/api/x', '/qb/index', 'GET').port === 6099,
    findRoute(flipped, '/api/x', '/qb/index', 'GET').port,
    6099,
  )
}

/* ---------- 汇总 ---------- */
const failed = check.summary('路由层 ')
process.exit(failed ? 1 : 0)
