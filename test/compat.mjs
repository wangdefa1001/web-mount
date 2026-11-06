import { normalizeConfig, readSettings } from '../lib/config.js'
import { computeServices } from '../lib/status.js'
let fail = 0
const t = (n, cond, got) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + n); if (!cond) { fail++; console.log('      got=', JSON.stringify(got)) } }

// 1. 完全空配置
t('空配置不报错', normalizeConfig({}).routes.length === 0, normalizeConfig({}))
t('null 配置不报错', normalizeConfig(null).routes.length === 0, '')

// 2. 旧配置缺新字段 → 默认值必须是"安全"的那一侧
const s = readSettings({})
t('未配置 refererSameOriginOnly 时默认为 true（安全默认）', s.refererSameOriginOnly === true, s.refererSameOriginOnly)
t('未配置 trailingSlashRedirect 时默认为 true（保持原有行为）', s.trailingSlashRedirect === true, s.trailingSlashRedirect)

// 3. 老用户显式关掉新开关 → 能关
const s2 = readSettings({ refererSameOriginOnly: false, trailingSlashRedirect: false })
t('显式 false 能生效', s2.refererSameOriginOnly === false && s2.trailingSlashRedirect === false, s2)

// 4. 用户现有配置（完全没有新字段）迁移后路由条数与字段不变
const USER_ROUTES_JSON = [
  { enable: true, name: 'meme预览站', matchPath: '/memes', host: '127.0.0.1', port: 3132, prefix: '/memes' },
  { enable: true, name: 'GsCore面板', matchPath: '/zy', host: '127.0.0.1', port: 8765, prefix: '/app' },
  { enable: true, name: 'GsCore资源', matchPath: '/app', host: '127.0.0.1', port: 8765, prefix: '/app' },
  { enable: true, name: 'NapCat WebUI', matchPath: '/webui', host: '127.0.0.1', port: 6099, prefix: '/webui', ws: true },
  { enable: true, name: 'NapCat文件', matchPath: '/files', host: '127.0.0.1', port: 6099, prefix: '/files' },
  { enable: true, name: 'NapCat入口', matchPath: '/ncqq', host: '127.0.0.1', port: 6099, prefix: '/' },
  { enable: true, name: 'GsCore API', matchPath: '/api', matchReferer: '/zy|/app|/daily-analyisis-gscore', host: '127.0.0.1', port: 8765, prefix: '/api' },
  { enable: true, name: 'NapCat API', matchPath: '/api', matchReferer: '/webui|/ncqq', host: '127.0.0.1', port: 6099, prefix: '/api' },
  { enable: true, name: '青龙', matchPath: '/qinglong', host: '127.0.0.1', port: 5700, prefix: '/' },
  { enable: true, name: 'daily', matchPath: '/daily-analyisis-gscore', host: '127.0.0.1', port: 8765, prefix: '/daily-analyisis-gscore', entry: true },
  { enable: true, name: 'agents', matchPath: '/agents', host: '127.0.0.1', port: 6098, prefix: '/' },
  { enable: true, name: 'agents API', matchPath: '/api', matchReferer: '/agents', host: '127.0.0.1', port: 6098, prefix: '/api' },
]
const userCfg = { routes: USER_ROUTES_JSON }
const norm = normalizeConfig(userCfg)
t('用户配置 12 条路由全部保留', norm.routes.length === 12, norm.routes.length)
t('用户配置未被注入 __invalidPort', norm.routes.every(r => !('__invalidPort' in r)), norm.routes.map(r => r.__invalidPort))
t('entry:true 保留', norm.routes.filter(r => r.entry === true).length === 1, norm.routes.filter(r => r.entry === true).map(r => r.name))

// 5. 端口字符串 '8765' 仍被接受
t("端口写成字符串 '8765' 仍生效", normalizeRoutePort('8765') === 8765, normalizeRoutePort('8765'))
function normalizeRoutePort(p) { return normalizeConfig({ routes: [{ enable: true, matchPath: '/a', port: p }] }).routes[0].port }

// 6. 端口 '8765 '（带空格）应被接受
t("端口写成 '8765 '（带空格）被接受", normalizeRoutePort('8765 ') === 8765, normalizeRoutePort('8765 '))

// 7. 非法端口被标记但不丢
const bad = normalizeConfig({ routes: [
  { enable: true, name: 'a', matchPath: '/a', port: 8765 },
  { enable: true, name: 'b', matchPath: '/b', port: 'abc' },
  { enable: true, name: 'c', matchPath: '/c', port: 70000 },
]})
t('非法端口路由被保留', bad.routes.length === 3, bad.routes.length)
t("非法端口被标记 __invalidPort", bad.routes[1].__invalidPort === 'abc' && bad.routes[2].__invalidPort === '70000',
  bad.routes.map(r => r.__invalidPort))

// 8. 入口聚合：单一服务的常见形态不重复出卡
const svc = (name, port, prefix, extra = {}) => ({ name, host: '127.0.0.1', port, prefix, matchPath: '/' + name, online: true, ...extra })
const a = computeServices([
  { name: '面板', host: '127.0.0.1', port: 8765, prefix: '/app', matchPath: '/zy', online: true },
  { name: '资源', host: '127.0.0.1', port: 8765, prefix: '/app', matchPath: '/app', online: true },
  { name: '接口', host: '127.0.0.1', port: 8765, prefix: '/api', matchPath: '/api', online: true },
])
t('同端口同前缀只出一张（/zy 与 /app）', a.length === 1 && a[0].matchPath === '/zy', a.map(x => x.name + '@' + x.matchPath))

// 9. 两台后端各自出卡
const b = computeServices([svc('A', 1001, '/'), svc('B', 1002, '/')])
t('不同端口各出一张', b.length === 2, b.map(x => x.name))

// 10. 所有路由都标 entry:false → 一张都不出
const c = computeServices([svc('A', 1001, '/', { entry: false }), svc('B', 1002, '/', { entry: false })])
t('全部标隐藏时不出卡', c.length === 0, c.map(x => x.name))

// 11. 空路由不出卡
t('空路由不出卡', computeServices([]).length === 0, '')

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
