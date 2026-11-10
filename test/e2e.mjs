/**
 * web-mount 端到端自检：真实启动插件，用真实 HTTP 请求验证行为。
 * 用法： node test/e2e.mjs
 * 退出码 0 = 全部通过。会自动在临时目录搭一个最小 Yunzai 结构，跑完即清理。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

import { makeSandbox, loggerStub, makeChecker } from './sandbox.mjs'

// 把 SSE 的等待时间压到毫秒级，否则自检要跑好几分钟
process.env.WEB_MOUNT_SSE_GRACE_MS = '800'
process.env.WEB_MOUNT_SSE_PING_MS = '1200'
process.env.WEB_MOUNT_SSE_HINT_MS = '3000'

const { root: SANDBOX, plugin: PLUGIN } = makeSandbox()
const PORT = 12536
const BACKENDS = {}

loggerStub()

const check = makeChecker()

/* ---------- 后端桩：每个端口一个，回显收到的东西 ---------- */
function backend(port, tag) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        })
        res.end(JSON.stringify({ tag, method: req.method, url: req.url, host: req.headers.host, body }))
      })
    })
    srv.listen(port, '127.0.0.1', () => {
      BACKENDS[tag] = srv
      resolve()
    })
  })
}

/* ---------- 前置：写测试配置 ---------- */
const CFG_DIR = path.join(PLUGIN, 'config')
const CFG_FILE = path.join(CFG_DIR, 'config.json')
let cfgBackup = null
if (fs.existsSync(CFG_FILE)) cfgBackup = fs.readFileSync(CFG_FILE)

function writeCfg(obj) {
  fs.mkdirSync(CFG_DIR, { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(obj, null, 2))
}

/* ---------- 启动被测插件 ---------- */
const express = {
  stack: [],
  // Yunzai(trss) 的 Bot.express 上挂着 quiet 数组：命中的路径把它的
  // 「HTTP GET 请求 { headers }」日志降级为 debug。这里照实模拟。
  quiet: [],
  use(fn) {
    this.stack.push(fn)
  },
}
const server = http.createServer((req, res) => {
  const next = () => {
    res.writeHead(418)
    res.end('passed-to-yunzai')
  }
  let i = 0
  const step = () => {
    const fn = express.stack[i++]
    if (!fn) return next()
    fn(req, res, step)
  }
  step()
})
/* 复刻 Yunzai lib/bot.js 的 wsConnect：首段路径不是已注册处理器就 404 + 销毁。
 * 这条必须在插件 init 之前挂上，才是真实顺序（框架先注册，插件后接管）。 */
const fwUpgrades = []
server.on('upgrade', (rq, sock) => {
  fwUpgrades.push(rq.url)
  try {
    sock.write('HTTP/1.1 404 Not Found\r\n\r\n')
    sock.destroy()
  } catch {
    /* ignore */
  }
})
globalThis.Bot = { express, server, logger: globalThis.logger }

const mod = await import(path.join(PLUGIN, 'index.js') + '?t=' + Date.now())
const { state: state0 } = await import(path.join(PLUGIN, 'lib/status.js'))
const plugin = new mod.default()
await plugin.init()

await new Promise(r => server.listen(PORT, '127.0.0.1', r))

/* ---------- 请求工具 ---------- */
function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, `http://127.0.0.1:${PORT}`)
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(txt)
        } catch {
          /* 非 JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text: txt, json })
      })
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

/* ================= 用例 ================= */

// 基线配置：贴近用户真实拓扑
const userRoutes = [
  { enable: true, name: 'meme预览站', matchPath: '/memes', host: '127.0.0.1', port: 3132, prefix: '/memes' },
  { enable: true, name: 'GsCore面板', matchPath: '/zy', host: '127.0.0.1', port: 8765, prefix: '/app' },
  { enable: true, name: 'GsCore资源', matchPath: '/app', host: '127.0.0.1', port: 8765, prefix: '/app' },
  {
    enable: true,
    name: 'NapCat WebUI',
    matchPath: '/webui',
    host: '127.0.0.1',
    port: 6099,
    prefix: '/webui',
    ws: true,
  },
  { enable: true, name: 'NapCat文件', matchPath: '/files', host: '127.0.0.1', port: 6099, prefix: '/files' },
  { enable: true, name: 'NapCat入口', matchPath: '/ncqq', host: '127.0.0.1', port: 6099, prefix: '/' },
  {
    enable: true,
    name: 'GsCore API',
    matchPath: '/api',
    matchReferer: '/zy|/app|/daily-analyisis-gscore',
    host: '127.0.0.1',
    port: 8765,
    prefix: '/api',
  },
  {
    enable: true,
    name: 'NapCat API',
    matchPath: '/api',
    matchReferer: '/webui|/ncqq',
    host: '127.0.0.1',
    port: 6099,
    prefix: '/api',
  },
  { enable: true, name: '青龙', matchPath: '/qinglong', host: '127.0.0.1', port: 5700, prefix: '/' },
  {
    enable: true,
    name: 'daily',
    matchPath: '/daily-analyisis-gscore',
    host: '127.0.0.1',
    port: 8765,
    prefix: '/daily-analyisis-gscore',
    entry: true,
  },
  { enable: true, name: 'agents', matchPath: '/agents', host: '127.0.0.1', port: 6098, prefix: '/' },
  {
    enable: true,
    name: 'agents API',
    matchPath: '/api',
    matchReferer: '/agents',
    host: '127.0.0.1',
    port: 6098,
    prefix: '/api',
  },
]

await Promise.all([
  backend(3132, 'memes'),
  backend(8765, 'gscore'),
  backend(6099, 'napcat'),
  backend(5700, 'qinglong'),
  backend(6098, 'agents'),
])

writeCfg({
  routes: userRoutes,
  autoReload: false,
  statusPage: true,
  statusToken: '',
  debug: false,
  allowEmbed: true,
  configEditor: true,
})
plugin.reloadConfig(true)

// 1. 最长路径优先：/memes 不被 / 抢走
{
  const r = await req('/memes/a.png')
  check('最长路径优先 /memes/a.png -> memes', r.json?.tag === 'memes' && r.json?.url === '/memes/a.png', r.json, {
    tag: 'memes',
    url: '/memes/a.png',
  })
}

// 2. prefix 别名：/zy/x -> /app/x
{
  const r = await req('/zy/dashboard')
  check('别名 /zy/dashboard -> /app/dashboard', r.json?.tag === 'gscore' && r.json?.url === '/app/dashboard', r.json, {
    tag: 'gscore',
    url: '/app/dashboard',
  })
}

// 3. 剥离前缀：/ncqq/abc -> /abc
{
  const r = await req('/ncqq/abc')
  check('剥离前缀 /ncqq/abc -> /abc', r.json?.tag === 'napcat' && r.json?.url === '/abc', r.json, {
    tag: 'napcat',
    url: '/abc',
  })
}

// 4. 按来源分流 /api
{
  const a = await req('/api/env', { headers: { referer: `http://127.0.0.1:${PORT}/webui/index.html` } })
  const b = await req('/api/env', { headers: { referer: `http://127.0.0.1:${PORT}/zy/x` } })
  const c = await req('/api/env', { headers: { referer: `http://127.0.0.1:${PORT}/agents/x` } })
  check('来源分流 /api by /webui -> napcat', a.json?.tag === 'napcat', a.json, 'napcat')
  check('来源分流 /api by /zy -> gscore', b.json?.tag === 'gscore', b.json, 'gscore')
  check('来源分流 /api by /agents -> agents', c.json?.tag === 'agents', c.json, 'agents')
}

// 5. 【P0-2】跨站伪造 Referer 不应命中受来源限制的路由
{
  const r = await req('/api/env', { headers: { referer: 'http://evil.example.com/zy' } })
  check(
    '跨站 Referer http://evil.example.com/zy 不得命中 gscore',
    r.json?.tag !== 'gscore',
    r.json?.tag,
    '不转发（418）或兜底',
  )
}

// 6. 未匹配路径放行给 Yunzai
{
  const r = await req('/yunzai-own-route')
  check(
    '未匹配路径放行给 Yunzai',
    r.status === 418 && r.text === 'passed-to-yunzai',
    { s: r.status, t: r.text },
    { s: 418 },
  )
}

// 7. 【P1】POST 空 body 不应挂死
{
  const t0 = Date.now()
  const r = await req('/memes/post', { method: 'POST', headers: { 'content-length': '0' }, body: '' })
  const ms = Date.now() - t0
  check(
    'POST content-length:0 立即返回（不挂到超时）',
    r.status === 200 && ms < 3000,
    { s: r.status, ms },
    { s: 200, ms: '<3000' },
  )
}

// 8. POST 带 JSON body 不丢
{
  const payload = JSON.stringify({ hello: '世界', n: 42 })
  const r = await req('/memes/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    body: payload,
  })
  check('POST JSON body 完整转发', r.json?.body === payload, r.json?.body, payload)
}

// 9. 嵌入头剥离
{
  const r = await req('/zy/x')
  check('allowEmbed 剥掉 X-Frame-Options', !r.headers['x-frame-options'], r.headers['x-frame-options'], undefined)
  check(
    'allowEmbed 去掉 CSP frame-ancestors',
    !/frame-ancestors/.test(r.headers['content-security-policy'] || ''),
    r.headers['content-security-policy'],
    '无 frame-ancestors',
  )
  check(
    'allowEmbed 保留 CSP 其余指令',
    /default-src/.test(r.headers['content-security-policy'] || ''),
    r.headers['content-security-policy'],
    "含 default-src 'self'",
  )
}

// 10. 精确命中补斜杠
{
  const r = await req('/memes')
  check(
    'GET /memes -> 302 /memes/',
    r.status === 302 && r.headers.location === '/memes/',
    { s: r.status, loc: r.headers.location },
    { s: 302, loc: '/memes/' },
  )
  const r2 = await req('/memes?a=1')
  check('GET /memes?a=1 -> 302 /memes/?a=1', r2.headers.location === '/memes/?a=1', r2.headers.location, '/memes/?a=1')
}

// 11. 【P0-1】入口卡片聚合
{
  const st = await (await req('/__web-mount__?format=json')).json
  const names = (st.services || []).map(s => s.name).sort()
  const expect = ['GsCore面板', 'NapCat WebUI', 'agents', 'daily', 'meme预览站', '青龙'].sort()
  check('入口卡片包含 NapCat WebUI（同端口多页面不丢）', names.includes('NapCat WebUI'), names, expect)
  check('入口卡片不含纯接口路径', !names.some(n => /API|文件|资源/.test(n)), names, '无 API/文件/资源')
}

// 12. 同端口多个 prefix=/ 的取舍：保守策略——只出一张（指向后端根），
//     目的是防止「一个服务被拆成好几条 /xxx + prefix=/ 的路由」时冒出多张重复卡片。
//     注意：这样的配置本身有歧义（全是后端根，无法区分是同一页面还是不同页面），
//     正确写法是给每个页面填它真实的目标前缀。
{
  writeCfg({
    routes: [
      { enable: true, name: '页A', matchPath: '/pa', host: '127.0.0.1', port: 3132, prefix: '/' },
      { enable: true, name: '页B', matchPath: '/pb', host: '127.0.0.1', port: 3132, prefix: '/' },
    ],
    autoReload: false,
    statusPage: true,
    statusToken: '',
    allowEmbed: true,
    configEditor: true,
  })
  plugin.reloadConfig(true)
  const st = await (await req('/__web-mount__?format=json')).json
  const names = st.services.map(s => s.name)
  check('同端口多个 prefix=/ 只出一张（避免重复卡片）', names.length === 1, names, ['页A'])
}

// 12b. 同端口多个 prefix=/ 但都标了 entry=显示 → 尊重用户，各出一张
{
  writeCfg({
    routes: [
      { enable: true, name: '页A', matchPath: '/pa', host: '127.0.0.1', port: 3132, prefix: '/', entry: true },
      { enable: true, name: '页B', matchPath: '/pb', host: '127.0.0.1', port: 3132, prefix: '/', entry: true },
    ],
    autoReload: false,
    statusPage: true,
    statusToken: '',
    allowEmbed: true,
    configEditor: true,
  })
  plugin.reloadConfig(true)
  const st = await (await req('/__web-mount__?format=json')).json
  const names = st.services.map(s => s.name).sort()
  check('两条都标「显示」时各出一张', names.join(',') === '页A,页B', names, ['页A', '页B'])
}

// 13. 【P0-4】端口非法的路由不应静默消失（应保留并被禁用）
{
  writeCfg({
    routes: [
      { enable: true, name: '好路由', matchPath: '/ok', host: '127.0.0.1', port: 3132, prefix: '/' },
      { enable: true, name: '端口写错', matchPath: '/bad', host: '127.0.0.1', port: 0, prefix: '/' },
    ],
    autoReload: false,
    statusPage: true,
    statusToken: '',
    allowEmbed: true,
    configEditor: true,
  })
  const cfgMod = await import(path.join(PLUGIN, 'lib/config.js'))
  const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
  const norm = cfgMod.normalizeConfig(raw)
  check('normalizeConfig 保留端口非法的路由（供日志提示）', norm.routes.length === 2, norm.routes.length, 2)
  plugin.reloadConfig(true)
  const r = await req('/bad/x')
  check('端口非法的路由不生效（放行给 Yunzai）', r.status === 418, r.status, 418)
}

// 14. 【autoApi】页面勾「自动 /api」后，不必再手工配一条 /api
{
  writeCfg({
    routes: [
      { enable: true, name: '面板', matchPath: '/zy', host: '127.0.0.1', port: 8765, prefix: '/app', autoApi: true },
      {
        enable: true,
        name: '另一个页面',
        matchPath: '/webui',
        host: '127.0.0.1',
        port: 6099,
        prefix: '/webui',
        autoApi: true,
      },
      { enable: true, name: '没开自动', matchPath: '/qinglong', host: '127.0.0.1', port: 5700, prefix: '/' },
    ],
    autoReload: false,
    statusPage: true,
    statusToken: '',
    allowEmbed: true,
    configEditor: true,
  })
  plugin.reloadConfig(true)

  const a = await req('/api/env', { headers: { referer: `http://127.0.0.1:${PORT}/zy/x` } })
  check(
    'autoApi：/api 带 /zy 来源 -> gscore（无需手工配置）',
    a.json?.tag === 'gscore' && a.json?.url === '/api/env',
    a.json,
    { tag: 'gscore', url: '/api/env' },
  )

  const b = await req('/api/env', { headers: { referer: `http://127.0.0.1:${PORT}/webui/x` } })
  check('autoApi：/api 带 /webui 来源 -> napcat', b.json?.tag === 'napcat', b.json, { tag: 'napcat' })

  const c = await req('/api/env', { headers: { referer: 'http://evil.example.com/zy' } })
  check('autoApi：跨站伪造来源仍然拦得住', c.status === 418, c.status, 418)

  const d = await req('/api/env')
  check('autoApi：无来源不命中（不会变成兜底）', d.status === 418, d.status, 418)

  const e = await req('/qinglong/api/env')
  check('autoApi：没开的页面行为不变', e.json?.tag === 'qinglong' && e.json?.url === '/api/env', e.json, {
    tag: 'qinglong',
  })

  const st = await (await req('/__web-mount__?format=json')).json
  check('autoApi：派生路由标成自动', st.totals.auto === 2, st.totals.auto, 2)
  check(
    'autoApi：派生路由不变成服务入口卡片',
    st.services.every(s => s.matchPath !== '/api'),
    st.services.map(s => s.matchPath),
    '无 /api 卡片',
  )
}

// 15. 【P1-1】config.json 写入是原子的：写入过程中读不到半截文件
{
  const cfgMod = await import(path.join(PLUGIN, 'lib/config.js'))
  const big = { routes: userRoutes, pad: 'x'.repeat(200000) }
  let broken = 0
  for (let i = 0; i < 30; i++) {
    cfgMod.writeConfigFile(PLUGIN, big)
    const txt = fs.readFileSync(CFG_FILE, 'utf8')
    try {
      JSON.parse(txt)
    } catch {
      broken++
    }
  }
  check('writeConfigFile 结果始终可被 JSON.parse', broken === 0, broken, 0)
  check(
    'writeConfigFile 不残留临时文件',
    !fs.readdirSync(CFG_DIR).some(f => f.endsWith('.tmp')),
    fs.readdirSync(CFG_DIR),
    '无 .tmp',
  )
}

// 15. 【P0-3】旧格式迁移保留规则自带的 matchPath
{
  const cfgMod = await import(path.join(PLUGIN, 'lib/config.js'))
  const migrated = cfgMod.normalizeConfig({
    mounts: [{ enable: true, note: '老挂载', path: '/old', host: '127.0.0.1', port: 3132, prefix: '/' }],
    dispatch: {
      enable: true,
      path: '/api',
      rules: [
        { enable: true, name: '自带路径', matchPath: '/login', host: '127.0.0.1', port: 3132, prefix: '/' },
        { enable: true, name: '无路径', host: '127.0.0.1', port: 3132, prefix: '/' },
      ],
    },
  })
  const paths = migrated.routes.map(r => r.matchPath)
  check('旧格式迁移：自带 matchPath 的规则不被改成 /api', paths.includes('/login'), paths, '含 /login')
  check(
    '旧格式迁移：无 matchPath 的规则落到 dispatch.path',
    paths.filter(p => p === '/api').length === 1,
    paths,
    '一条 /api',
  )
}

// 16. 【P1-4】WS upgrade 也受来源限制
{
  writeCfg({
    routes: [
      {
        enable: true,
        name: 'wsA',
        matchPath: '/ws',
        matchReferer: '/zy',
        host: '127.0.0.1',
        port: 6099,
        prefix: '/ws',
        ws: true,
      },
      { enable: true, name: 'wsB', matchPath: '/ws', host: '127.0.0.1', port: 3132, prefix: '/ws', ws: true },
    ],
    autoReload: false,
    statusPage: true,
    statusToken: '',
    allowEmbed: true,
    configEditor: true,
  })
  plugin.reloadConfig(true)
  // 用一个 TCP 假 upgrade 请求，看插件把连接转到哪
  const net = await import('node:net')
  const hits = []
  // BACKENDS 用的是 listen(PORT, '127.0.0.1')，这里要先关掉复用同一端口
  for (const [tag, s] of Object.entries(BACKENDS)) {
    await new Promise(r => s.close(r))
    delete BACKENDS[tag]
  }
  const srvA = http.createServer()
  srvA.on('upgrade', (rq, sock) => {
    hits.push('A')
    sock.destroy()
  })
  const srvB = http.createServer()
  srvB.on('upgrade', (rq, sock) => {
    hits.push('B')
    sock.destroy()
  })
  await new Promise(r => srvA.listen(6099, '127.0.0.1', r))
  await new Promise(r => srvB.listen(3132, '127.0.0.1', r))
  const tryWs = referer =>
    new Promise(resolve => {
      const s = net.connect(PORT, '127.0.0.1', () => {
        s.write(
          `GET /ws/live HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n`
            + (referer ? `Referer: ${referer}\r\n` : '')
            + '\r\n',
        )
      })
      s.on('data', () => {})
      s.on('close', resolve)
      s.on('error', resolve)
      setTimeout(() => {
        s.destroy()
        resolve()
      }, 1500)
    })
  await tryWs(`http://127.0.0.1:${PORT}/zy`)
  await tryWs(`http://evil.example.com/zy`)
  await tryWs('')
  check('WS 带 /zy 来源 -> 后端A(6099)', hits[0] === 'A', hits, ['A', 'B', 'B'])
  check('WS 跨站来源 -> 兜底后端B(3132) 而非 A', hits[1] === 'B', hits, ['A', 'B', 'B'])
  check('WS 无来源 -> 兜底后端B(3132)', hits[2] === 'B', hits, ['A', 'B', 'B'])
  srvA.close()
  srvB.close()
}

/* ---------- 17. 框架 HTTP 日志静音：把接管路径塞进 Bot.express.quiet ---------- */
{
  const quiet = express.quiet
  writeCfg({
    routes: [
      { enable: true, name: '面板', matchPath: '/zy', host: '127.0.0.1', port: 8765, prefix: '/app' },
      {
        enable: true,
        name: '接口',
        matchPath: '/api',
        matchReferer: '/zy',
        host: '127.0.0.1',
        port: 8765,
        prefix: '/api',
      },
    ],
    autoReload: false,
    statusPage: true,
    statusToken: '',
    quietProxyLog: true,
  })
  plugin.reloadConfig(true)
  check('静音：/zy 被加入 quiet', quiet.includes('/zy'), quiet, 'contains /zy')
  check('静音：/api 被加入 quiet', quiet.includes('/api'), quiet, 'contains /api')
  check('静音：状态页路径被加入 quiet', quiet.includes('/__web-mount__'), quiet, 'contains /__web-mount__')

  // 热重载换了路径：旧的要撤掉，不能只加不减
  writeCfg({
    routes: [{ enable: true, name: '新面板', matchPath: '/panel', host: '127.0.0.1', port: 8765, prefix: '/' }],
    autoReload: false,
    statusPage: true,
    quietProxyLog: true,
  })
  plugin.reloadConfig(true)
  check('静音：热重载后旧的 /zy 被撤销', !quiet.includes('/zy'), quiet, 'not contains /zy')
  check('静音：热重载后新的 /panel 已加入', quiet.includes('/panel'), quiet, 'contains /panel')

  // 按框架 lib/bot.js 的 serverHandle 复刻判定逻辑：命中 quiet 就降级为 debug。
  // 这条是在验证「我们塞进去的东西，框架确实会按预期降级」，而不只是数组里有值。
  const levelOf = u => (quiet.some(p => u.startsWith(p)) ? 'debug' : 'mark')
  check('静音：/panel/x 会被框架降级为 debug', levelOf('/panel/x') === 'debug', levelOf('/panel/x'), 'debug')
  check('静音：未挂载的路径仍是 mark（不误伤）', levelOf('/yunzai-own') === 'mark', levelOf('/yunzai-own'), 'mark')

  // 别人（别的插件）自己 push 的路径不能被我们顺手删掉
  quiet.push('/other-plugin')
  writeCfg({
    routes: [{ enable: true, name: '新面板', matchPath: '/panel', host: '127.0.0.1', port: 8765, prefix: '/' }],
    autoReload: false,
    statusPage: true,
    quietProxyLog: true,
  })
  plugin.reloadConfig(true)
  check('静音：不误删别的插件加的路径', quiet.includes('/other-plugin'), quiet, 'contains /other-plugin')

  // 关掉开关：我们加的全部清掉，别人的留着
  writeCfg({
    routes: [{ enable: true, name: '新面板', matchPath: '/panel', host: '127.0.0.1', port: 8765, prefix: '/' }],
    autoReload: false,
    statusPage: true,
    quietProxyLog: false,
  })
  plugin.reloadConfig(true)
  check('静音：关掉开关后不残留我们的路径', !quiet.includes('/panel'), quiet, 'not contains /panel')
  check('静音：关掉开关也不影响别人的路径', quiet.includes('/other-plugin'), quiet, 'contains /other-plugin')
  check('静音：关掉开关后状态页路径也撤掉', !quiet.includes('/__web-mount__'), quiet, 'not contains /__web-mount__')

  // '/' 兜底路由绝不能加进去，否则整站日志全静音
  writeCfg({
    routes: [{ enable: true, name: '兜底', matchPath: '/', host: '127.0.0.1', port: 3132, prefix: '/' }],
    autoReload: false,
    statusPage: false,
    quietProxyLog: true,
  })
  plugin.reloadConfig(true)
  check("静音：'/' 兜底路由不会被静音（否则整站日志全没了）", !quiet.includes('/'), quiet, 'not contains /')
}

/* ---------- 18. 首次安装：没有 config.json 时从模板生成，且不带任何预置路由 ---------- */
{
  const hadCfg = fs.existsSync(CFG_FILE)
  const savedCfg = hadCfg ? fs.readFileSync(CFG_FILE) : null
  try {
    fs.rmSync(CFG_FILE, { force: true })

    const logs = []
    const realMark = globalThis.logger.mark
    const realInfo = globalThis.logger.info
    globalThis.logger.mark = (...a) => {
      logs.push(['mark', a.join(' ')])
      realMark(...a)
    }
    globalThis.logger.info = (...a) => {
      logs.push(['info', a.join(' ')])
      realInfo(...a)
    }

    plugin.reloadConfig(false)

    globalThis.logger.mark = realMark
    globalThis.logger.info = realInfo

    check('首次安装：config.json 被自动生成', fs.existsSync(CFG_FILE), false, true)
    const written = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    check('首次安装：生成的文件没有任何预置路由', written.routes.length === 0, written.routes.length, 0)
    check('首次安装：运行时也没有任何路由', plugin.status && state0.routes.length === 0, state0.routes.length, 0)
    check(
      '首次安装：日志里给出了状态页入口',
      logs.some(([, m]) => m.includes('首次运行') && m.includes('/__web-mount__')),
      logs.filter(([, m]) => m.includes('web-mount')).map(([, m]) => m),
      '含「首次运行」与 /__web-mount__ 的日志',
    )
    check(
      '首次安装：提示里不再叫用户去翻 config.json 手写',
      !logs.some(([, m]) => m.includes('没有可用的路由，请在 config.json')),
      logs.map(([, m]) => m),
      '无旧提示',
    )

    // 不是首次时不该再报「首次运行」
    const logs2 = []
    globalThis.logger.mark = (...a) => {
      logs2.push(a.join(' '))
      realMark(...a)
    }
    plugin.reloadConfig(true)
    globalThis.logger.mark = realMark
    check('已有配置时不再提示首次运行', !logs2.some(m => m.includes('首次运行')), logs2, '不含「首次运行」')
  } finally {
    if (savedCfg) fs.writeFileSync(CFG_FILE, savedCfg)
    else fs.rmSync(CFG_FILE, { force: true })
  }
}

/* ---------- 19. 后端自己返回 5xx 时要留痕，否则用户分不清是谁的锅 ---------- */
{
  const srv = http.createServer((rq, rs) => {
    rs.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    rs.end('upstream died')
  })
  await new Promise(r => srv.listen(8771, '127.0.0.1', r))
  writeCfg({
    routes: [{ enable: true, name: '会回502的后端', matchPath: '/bad', host: '127.0.0.1', port: 8771, prefix: '/' }],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)

  const warns = []
  const realWarn = globalThis.logger.warn
  globalThis.logger.warn = (...a) => {
    warns.push(a.join(' '))
    realWarn(...a)
  }
  const r = await req('/bad/x')
  globalThis.logger.warn = realWarn

  check('后端 5xx：状态码原样透传', r.status === 502, r.status, 502)
  check('后端 5xx：响应体是后端的，不是我们的诊断文本', r.text === 'upstream died', r.text, 'upstream died')
  check(
    '后端 5xx：日志里明确写了「后端返回」而不是「转发失败」',
    warns.some(m => m.includes('后端返回 502') && m.includes('不是转发失败')),
    warns,
    '含「后端返回 502 ... 不是转发失败」',
  )
  check(
    '后端 5xx：日志带上了路由名、目标端口与实际转发路径，能直接定位',
    // prefix 是 '/'，所以 /bad/x 转发到后端是 /x —— 日志里记的必须是转发后的真实路径
    warns.some(m => m.includes('会回502的后端') && m.includes('127.0.0.1:8771/x')),
    warns,
    '含路由名 + 127.0.0.1:8771/x',
  )

  // 统计里要算进错误数，状态页的错误列才有意义
  const api = globalThis.__webMountApi
  const st = (await api.collect()).routes.find(x => x.matchPath === '/bad')
  check('后端 5xx：计入错误统计', st && st.errors >= 1, st && st.errors, '>=1')
  check('后端 5xx：记录的状态码是 502', st && st.lastStatus === 502, st && st.lastStatus, 502)

  srv.close()
}

/* ---------- 20. 状态页前端：结构完整性（防改坏） ---------- *
 * guoba/ 下这三个文件是手工维护的前端，没有构建步骤，写错了只有在浏览器里
 * 才看得出来。这里做静态自检：元素 id 与 JS 引用对得上、样式表里没有引用
 * 不存在的类名、毛玻璃只用在浮层上。
 */
{
  const gdir = path.join(PLUGIN, 'guoba')
  const html = fs.readFileSync(path.join(gdir, 'dashboard.html'), 'utf8')
  const css = fs.readFileSync(path.join(gdir, 'dashboard.css'), 'utf8')
  const src = fs.readFileSync(path.join(gdir, 'dashboard.js'), 'utf8')

  // JS 里用 $('xxx') 取的每个 id，HTML 里都得存在，否则运行时直接 null.xxx。
  // 例外：JS 自己用 innerHTML 拼出来、随后立刻 getElementById 的动态元素。
  const DYN_IDS = new Set(['empty-add'])
  const usedIds = [...new Set([...src.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]))]
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
  const missingIds = usedIds.filter(id => !htmlIds.has(id) && !DYN_IDS.has(id))
  check('状态页：JS 引用的 id 在 HTML 里都存在', missingIds.length === 0, missingIds, [])

  // 反方向：HTML 里定义了、但 JS 与 CSS 都不引用的 id（多半是删代码时忘了清结构）。
  // 纯展示用的静态文案（如 sites-hint）也允许留着，但仍受此检查约束 ——
  // 一旦它彻底没人用，就该删掉。
  const jsMentions = id => src.includes("'" + id + "'") || src.includes('"' + id + '"')
  const orphanIds = [...htmlIds].filter(id => !jsMentions(id) && !css.includes('#' + id))
  check('状态页：HTML 里没有彻底没人用的 id', orphanIds.length === 0, orphanIds, [])

  // 关键浮层必须真的带 backdrop-filter
  const glassBlocks = ['.top', '.drawer-panel', '#toast', '.confirm']
  const noGlass = glassBlocks.filter(sel => {
    const i = css.indexOf('\n' + sel + ' {')
    if (i < 0) return true
    const block = css.slice(i, css.indexOf('}', i))
    return !/backdrop-filter:\s*blur/.test(block)
  })
  check('状态页：关键浮层都有毛玻璃', noGlass.length === 0, noGlass, [])

  // 反过来：内容类容器不该开 backdrop-filter（大面积模糊会掉帧）
  const mustNotBlur = ['.panel {', '.card {', '.rt {']
  const wronglyBlurred = mustNotBlur.filter(sel => {
    const i = css.indexOf('\n' + sel)
    if (i < 0) return false
    const block = css.slice(i, css.indexOf('}', i))
    return /backdrop-filter:/.test(block)
  })
  check('状态页：内容容器没有滥用毛玻璃', wronglyBlurred.length === 0, wronglyBlurred, [])

  // 深浅色两套都要定义毛玻璃底色，否则某一模式会糊成半透明
  const glassBgCount = (css.match(/--glass-bg:/g) || []).length
  check('状态页：深浅两套主题都定义了毛玻璃底色', glassBgCount >= 2, glassBgCount, '>=2')

  // 不支持 backdrop-filter 时必须有降级（否则文字糊在背景上读不清）
  check('状态页：有 @supports 降级分支', /@supports not \(\(backdrop-filter/.test(css), false, true)

  // 前端脚本语法
  let syntaxOk = true
  try {
    new Function(src)
  } catch (e) {
    syntaxOk = false
    check('状态页：dashboard.js 语法错误 -> ' + e.message, false, e.message, 'no error')
  }
  if (syntaxOk) check('状态页：dashboard.js 语法正确', true, true, true)
}

/* ---------- 21. 断链错误要翻译成人话，且不能覆盖真实状态码 ---------- */
{
  // 后端 A：接受连接后立刻 destroy —— 复现 socket hang up
  const hangSrv = net.createServer(sock => sock.destroy())
  await new Promise(r => hangSrv.listen(8772, '127.0.0.1', r))

  // 后端 B：先回 200 + 响应体，再断链（模拟后端回了东西之后连接被掐）
  const halfSrv = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/plain' })
    rs.end('partial')
  })
  await new Promise(r => halfSrv.listen(8773, '127.0.0.1', r))

  writeCfg({
    routes: [
      { enable: true, name: '会断链的后端', matchPath: '/hang', host: '127.0.0.1', port: 8772, prefix: '/' },
      { enable: true, name: '正常返回的后端', matchPath: '/ok', host: '127.0.0.1', port: 8773, prefix: '/' },
    ],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)

  const warns = []
  const realWarn = globalThis.logger.warn
  globalThis.logger.warn = (...a) => {
    warns.push(a.join(' '))
    realWarn(...a)
  }
  const rHang = await req('/hang/api/Plugin/Store/List')
  globalThis.logger.warn = realWarn

  check('断链：客户端收到 502', rHang.status === 502, rHang.status, 502)
  check(
    '断链：日志保留了原始 err.message（便于搜素经验贴）',
    warns.some(m => m.includes('socket hang up')),
    warns,
    '含 socket hang up',
  )
  check(
    '断链：日志附带人话解释，指出是后端在返回响应前关的连接',
    warns.some(m => m.includes('后端在返回响应前就关闭了连接')),
    warns,
    '含「后端在返回响应前就关闭了连接」',
  )
  check(
    '断链：日志带上了已发出的请求字节数，可用于区分「请求未发出」与「发了没回」',
    warns.some(m => /已发出 \d+ 字节请求头/.test(m)),
    warns,
    '含「已发出 N 字节请求头」',
  )

  // 正常后端未监听时给的是 ECONNREFUSED 的专门解释，不要和 hang up 混为一谈
  writeCfg({
    routes: [{ enable: true, name: '没监听的端口', matchPath: '/dead', host: '127.0.0.1', port: 8779, prefix: '/' }],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)
  const warns2 = []
  globalThis.logger.warn = (...a) => {
    warns2.push(a.join(' '))
    realWarn(...a)
  }
  await req('/dead/x')
  globalThis.logger.warn = realWarn
  check(
    '拒绝连接：解释为「端口没有进程在监听」',
    warns2.some(m => m.includes('没有进程在监听')),
    warns2,
    '含「没有进程在监听」',
  )

  hangSrv.close()
  halfSrv.close()
}

/* ---------- 22. 超时也要能区分「连不上」与「连上了但不回」 ---------- */
{
  // 后端：接受连接、读完请求，但永不响应
  const muteSrv = http.createServer(() => {
    /* 故意不回 */
  })
  await new Promise(r => muteSrv.listen(8774, '127.0.0.1', r))

  // proxyTimeout 最小允许 1000ms，测试里用 1000 以免拖慢
  writeCfg({
    proxyTimeout: 1000,
    routes: [
      { enable: true, name: '不响应的后端', matchPath: '/mute', host: '127.0.0.1', port: 8774, prefix: '/' },
      { enable: true, name: '连不上的后端', matchPath: '/nope', host: '127.0.0.1', port: 8778, prefix: '/' },
    ],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)

  const warns = []
  const realWarn = globalThis.logger.warn
  globalThis.logger.warn = (...a) => {
    warns.push(a.join(' '))
    realWarn(...a)
  }
  const r1 = await req('/mute/api/Log/GetLogRealTime')
  await req('/nope/x')
  globalThis.logger.warn = realWarn

  check('超时：客户端收到 502', r1.status === 502, r1.status, 502)
  check(
    '超时：日志保留 timeout after Nms 原文',
    warns.some(m => /timeout after 1000ms/.test(m)),
    warns,
    '含 timeout after 1000ms',
  )
  check(
    '超时（连上了但不回）：解释为后端接口卡住，而不是网络不通',
    warns.some(m => m.includes('没返回任何响应') && m.includes('这个接口本身卡住')),
    warns,
    '含「没返回任何响应 ... 这个接口本身卡住」',
  )
  check(
    '超时（连上了但不回）：不应被误判成端口没监听',
    !warns.some(m => m.includes('不响应的后端') && m.includes('没有进程在监听')),
    warns,
    '不响应的后端不应出现「没有进程在监听」',
  )
  check(
    '超时（连不上）：解释为端口没监听/被拦截，与上面区分开',
    warns.some(m => m.includes('连不上的后端') && m.includes('没有进程在监听')),
    warns,
    '含「没有进程在监听」',
  )

  muteSrv.close()
}

/* ---------- 23. Host 透传与 Set-Cookie Domain（面板只能开不能用的问题） ---------- */
{
  // 模拟一个「挑 Host 的面板」：Host 不是自己认知的域名就 403，
  // 并且按 Host 下发绑死域名的 cookie
  const panel = http.createServer((rq, rs) => {
    const host = rq.headers.host || ''
    const origin = rq.headers.origin || ''
    // 没被改写的 Host 才是「从外部域名进来」，放行
    if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      rs.writeHead(403, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ error: 'host not allowed', host }))
      return
    }
    // 下发一条绑死 Domain 的 cookie（真实面板常见写法）
    rs.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': [`nap_token=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax`],
    })
    rs.end(JSON.stringify({ ok: true, host, origin }))
  })
  await new Promise(r => panel.listen(8775, '127.0.0.1', r))

  writeCfg({
    routes: [{ enable: true, name: '挑Host的面板', matchPath: '/panel', host: '127.0.0.1', port: 8775, prefix: '/' }],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)

  // 带一个外部域名 Host 去请求（模拟浏览器经 frp 访问）
  const r = await req('/panel/api/Log/GetLogRealTime', { headers: { host: 'frp-hat.com:14808' } })
  check('Host 透传：后端看到的是客户端原始 Host，不是后端地址', r.status === 200, r.status, 200)
  let parsed = {}
  try {
    parsed = JSON.parse(r.text)
  } catch {
    /* ignore */
  }
  check(
    'Host 透传：后端收到的 Host = frp-hat.com:14808',
    parsed.host === 'frp-hat.com:14808',
    parsed.host,
    'frp-hat.com:14808',
  )

  const rawCookie = r.headers['set-cookie']
  const cookieStr = Array.isArray(rawCookie) ? rawCookie.join('|') : String(rawCookie || '')
  check('Set-Cookie：Domain 已被剥掉（否则浏览器整条拒收）', !/domain=/i.test(cookieStr), cookieStr, '不含 domain=')
  check(
    'Set-Cookie：其余属性保留',
    /path=\//i.test(cookieStr) && /httponly/i.test(cookieStr),
    cookieStr,
    '含 Path 与 HttpOnly',
  )

  // preserveHost:false 时应退回旧行为（改写 Host）
  writeCfg({
    preserveHost: false,
    routes: [{ enable: true, name: '挑Host的面板', matchPath: '/panel', host: '127.0.0.1', port: 8775, prefix: '/' }],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)
  const r2 = await req('/panel/api/x', { headers: { host: 'frp-hat.com:14808' } })
  check('preserveHost=false：退回改写 Host（老后端兼容）', r2.status === 403, r2.status, 403)

  // 恢复默认，避免影响后续
  writeCfg({ preserveHost: true, routes: [], autoReload: false, statusPage: false, debug: false })
  plugin.reloadConfig(true)
  panel.close()
}

/* ---------- 24. 状态页探测接口：直连后端，把真实返回原样摊开 ---------- */
{
  // 后端：模拟 NapCat —— 某些接口正常返回，某些接口永不响应
  const napcat = http.createServer((rq, rs) => {
    if (rq.url.startsWith('/api/Log/GetLogRealTime')) {
      // 永不响应，模拟卡死
      return
    }
    rs.writeHead(200, { 'content-type': 'application/json' })
    rs.end(JSON.stringify({ ok: true, url: rq.url, gotHost: rq.headers.host }))
  })
  await new Promise(r => napcat.listen(8776, '127.0.0.1', r))

  writeCfg({
    statusToken: 'probe-pass',
    proxyTimeout: 1500,
    routes: [{ enable: true, name: '探测面板', matchPath: '/p', host: '127.0.0.1', port: 8776, prefix: '/' }],
    autoReload: false,
    statusPage: true,
    debug: false,
  })
  plugin.reloadConfig(true)

  // 未登录时禁止探测
  const unauth = await req(`/__web-mount__/probe?path=/api/x&port=8776&format=json`)
  check('探测：未登录直接拒绝', unauth.status === 401, unauth.status, 401)

  // 登录拿 cookie
  const login = await req('/__web-mount__', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=probe-pass',
  })
  const rawCookie = login.headers['set-cookie']
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : String(rawCookie || '')).split(';')[0]
  check('探测：登录成功拿到 cookie', /wm_auth=/.test(cookie), cookie, 'wm_auth=...')

  // 探测一个正常接口
  const okProbe = await req(`/__web-mount__/probe?path=/api/hello&port=8776&format=json`, { headers: { cookie } })
  const okBody = okProbe.json || {}
  check(
    '探测：正常接口回显 200',
    okBody.result && okBody.result.status === 200,
    okBody.result && okBody.result.status,
    200,
  )
  check(
    '探测：回显包含后端真实响应体',
    okBody.result && String(okBody.result.body).includes('/api/hello'),
    okBody.result && okBody.result.body,
    '含 /api/hello',
  )
  check(
    '探测：回显里能看到后端收到的 Host（用于核对 Host 透传是否生效）',
    okBody.result && typeof okBody.result.body === 'string' && okBody.result.body.includes('gotHost'),
    okBody.result && okBody.result.body,
    '含 gotHost',
  )

  // 探测一个卡死接口 —— 应在 proxyTimeout 内返回结构化的超时信息，而不是挂住
  const t0 = Date.now()
  const hangProbe = await req(`/__web-mount__/probe?path=/api/Log/GetLogRealTime&port=8776&format=json`, {
    headers: { cookie },
  })
  const spent = Date.now() - t0
  const hangBody = hangProbe.json || {}
  check('探测：卡死接口不会把请求挂住', spent < 6000, spent, '<6000ms')
  check(
    '探测：卡死接口如实回报 timeout',
    hangBody.result && /timeout/.test(String(hangBody.result.message)),
    hangBody.result && hangBody.result.message,
    '含 timeout',
  )

  // 不在路由表里的端口必须拒绝（防止变成开放代理）
  const evil = await req(`/__web-mount__/probe?path=/&port=22&format=json`, { headers: { cookie } })
  check('探测：拒绝探测未登记端口', evil.status === 400, evil.status, 400)

  // 恢复
  writeCfg({ statusToken: '', statusPage: true, routes: [], autoReload: false, debug: false })
  plugin.reloadConfig(true)
  napcat.close()
}

/* ---------- 25. SSE：实时日志 / 系统状态这种「不吭声」的流 ---------- *
 * NapCat WebUI 的实时日志和系统状态都是 SSE：先只 setHeader，
 * 之后**只有真的产生事件时才 write**。用普通请求的超时去管它，
 * 表现就是「日志页打开 30 秒变 502 / 实时日志永远空白」。
 */
{
  const sseSrv = http.createServer((rq, rs) => {
    const u = rq.url.split('?')[0]
    if (u.endsWith('/GetSysStatusRealTime')) {
      // 正常 SSE：事件持续产生
      rs.setHeader('Content-Type', 'text/event-stream')
      rs.setHeader('Connection', 'keep-alive')
      let n = 0
      const timer = setInterval(() => {
        n++
        rs.write(`data: {"n":${n}}\n\n`)
        if (n >= 3) {
          clearInterval(timer)
          rs.end()
        }
      }, 300)
      rq.on('close', () => clearInterval(timer))
      return
    }
    if (u.endsWith('/GetLogRealTime')) {
      // 安静型 SSE：2.5 秒内一个字节都不发，之后才来一条日志
      rs.setHeader('Content-Type', 'text/event-stream')
      rs.setHeader('Connection', 'keep-alive')
      const timer = setTimeout(() => rs.write('data: {"log":"hello"}\n\n'), 2500)
      rq.on('close', () => clearTimeout(timer))
      return
    }
    if (u.endsWith('/NeedAuth')) {
      rs.writeHead(401, { 'content-type': 'application/json' })
      rs.end('{"message":"Unauthorized"}')
      return
    }
    rs.writeHead(404, { 'content-type': 'text/plain' })
    rs.end('nope')
  })
  await new Promise(r => sseSrv.listen(8777, '127.0.0.1', r))

  writeCfg({
    // 故意把普通超时设得比 SSE 的安静期还短：SSE 不能被它掐死
    proxyTimeout: 1000,
    statusToken: 'sse-pass',
    routes: [{ enable: true, name: 'SSE 面板', matchPath: '/sse', host: '127.0.0.1', port: 8777, prefix: '/api' }],
    autoReload: false,
    statusPage: true,
    debug: false,
  })
  plugin.reloadConfig(true)

  const streamReq = (url, wait) =>
    new Promise(resolve => {
      const t0 = Date.now()
      const events = []
      const u = new URL(url, `http://127.0.0.1:${PORT}`)
      const r = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          headers: { accept: 'text/event-stream' },
        },
        res => {
          events.push({ at: Date.now() - t0, type: 'response', status: res.statusCode, headers: res.headers })
          res.on('data', c => events.push({ at: Date.now() - t0, type: 'data', text: c.toString('utf8') }))
          res.on('end', () => {
            events.push({ at: Date.now() - t0, type: 'end' })
            resolve(events)
          })
        },
      )
      r.on('error', () => resolve(events))
      r.end()
      setTimeout(() => {
        r.destroy()
        resolve(events)
      }, wait)
    })

  const normal = await streamReq('/sse/GetSysStatusRealTime', 2500)
  const firstResp = normal.find(e => e.type === 'response')
  const bodyText = normal
    .filter(e => e.type === 'data')
    .map(e => e.text)
    .join('')
  check(
    'SSE：正常流式接口 200，不被超时掐断',
    !!firstResp && firstResp.status === 200,
    firstResp && firstResp.status,
    200,
  )
  check(
    'SSE：content-type 保持 text/event-stream',
    !!firstResp && /text\/event-stream/.test(String(firstResp.headers['content-type'])),
    firstResp && firstResp.headers['content-type'],
    'text/event-stream',
  )
  check(
    'SSE：加了 x-accel-buffering:no（否则 nginx 会把流攒着不发）',
    !!firstResp && String(firstResp.headers['x-accel-buffering']) === 'no',
    firstResp && firstResp.headers['x-accel-buffering'],
    'no',
  )
  check('SSE：事件原样透传（data 帧不丢）', (bodyText.match(/data:/g) || []).length >= 2, bodyText, '>=2 帧')
  check(
    'SSE：流结束后正常收尾（没有变成 502）',
    normal.some(e => e.type === 'end'),
    normal.map(e => e.type),
    '含 end',
  )

  const quiet = await streamReq('/sse/GetLogRealTime', 4000)
  const qResp = quiet.find(e => e.type === 'response')
  const qText = quiet
    .filter(e => e.type === 'data')
    .map(e => e.text)
    .join('')
  check(
    'SSE 静默流：proxyTimeout 只有 1 秒，但连接仍在 800ms 时先给出 200 响应头',
    !!qResp && qResp.status === 200 && qResp.at >= 700 && qResp.at < 1600,
    qResp && { status: qResp.status, at: qResp.at },
    '200 @ ~800ms',
  )
  check(
    'SSE 静默流：等待期间注入注释行心跳（: 开头，客户端按规范忽略）',
    /(^|\n):\s*ping/.test(qText),
    qText.slice(0, 120),
    '含 ": ping"',
  )
  check(
    'SSE 静默流：后端 2.5 秒后来的第一条日志照常送达',
    qText.includes('"log":"hello"'),
    qText.slice(0, 200),
    '含 hello',
  )
  check(
    'SSE 静默流：全程没有 502（说明超时逻辑已让位于流式）',
    quiet.every(e => e.type !== 'response' || e.status === 200),
    quiet.map(e => (e.type === 'response' ? e.status : e.type)),
    '只有 200',
  )

  const auth = await streamReq('/sse/NeedAuth', 2000)
  const aResp = auth.find(e => e.type === 'response')
  check(
    'SSE：后端立刻拒绝时状态码原样透传，不会被「先发 200」盖掉',
    !!aResp && aResp.status === 401,
    aResp && aResp.status,
    401,
  )

  // 探测接口的流式模式：直接把「有没有首字节 / 收了几帧」摊开
  const login = await req('/__web-mount__', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=sse-pass',
  })
  const rawCookie = login.headers['set-cookie']
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : String(rawCookie || '')).split(';')[0]
  const probe = await req(`/__web-mount__/probe?path=/api/GetSysStatusRealTime&port=8777&ms=1200&format=json`, {
    headers: { cookie },
  })
  const pr = (probe.json || {}).result || {}
  check('探测（流式）：拿到首字节耗时', typeof pr.firstByteMs === 'number' && pr.firstByteMs > 0, pr.firstByteMs, '>0')
  check('探测（流式）：统计到事件帧数', (pr.frames || 0) >= 1, pr.frames, '>=1')
  check('探测（流式）：观察窗口到期就收工，不会挂到超时', typeof pr.ms === 'number' && pr.ms < 4000, pr.ms, '<4000')

  sseSrv.close()
}

/* ---------- 26. WS：接管后框架不能再插一脚（101 后追 404 的老问题） ---------- */
{
  const wsSrv = http.createServer((rq, rs) => {
    rs.writeHead(200)
    rs.end('plain')
  })
  wsSrv.on('upgrade', (rq, sock) => {
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummy\r\n\r\n',
    )
    sock.write('FROM-BACKEND')
  })
  await new Promise(r => wsSrv.listen(8781, '127.0.0.1', r))

  writeCfg({
    routes: [
      { enable: true, name: 'WS 后端', matchPath: '/wsx', host: '127.0.0.1', port: 8781, prefix: '/wsx', ws: true },
      { enable: true, name: '没开WS的后端', matchPath: '/nows', host: '127.0.0.1', port: 8781, prefix: '/' },
    ],
    autoReload: false,
    statusPage: false,
    debug: false,
  })
  plugin.reloadConfig(true)

  const upgrade = (pathname, wait = 1200) =>
    new Promise(resolve => {
      const chunks = []
      const s = net.connect(PORT, '127.0.0.1', () => {
        s.write(
          `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
            + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:'
            + PORT
            + '\r\n\r\n',
        )
      })
      s.on('data', c => chunks.push(c))
      s.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
      s.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
      setTimeout(() => {
        s.destroy()
        resolve(Buffer.concat(chunks).toString('utf8'))
      }, wait)
    })

  const before = fwUpgrades.length
  const okText = await upgrade('/wsx/live')
  check('WS：客户端收到后端的 101', /^HTTP\/1\.1 101/.test(okText), okText.split('\r\n')[0], 'HTTP/1.1 101 ...')
  check('WS：握手后的数据帧能透传', okText.includes('FROM-BACKEND'), okText.slice(0, 120), '含 FROM-BACKEND')
  check('WS：框架不再收到这条 upgrade（不会再追 404 断链）', fwUpgrades.length === before, fwUpgrades.slice(before), [])

  const warns = []
  const realWarn = globalThis.logger.warn
  globalThis.logger.warn = (...a) => {
    warns.push(a.join(' '))
    realWarn(...a)
  }
  const noWs = await upgrade('/nows/live')
  globalThis.logger.warn = realWarn

  check('WS：路由没开 ws 时明确回 501', /^HTTP\/1\.1 501/.test(noWs), noWs.split('\r\n')[0], 'HTTP/1.1 501 ...')
  check(
    'WS：没开 ws 时日志告诉用户怎么开，而不是「处理器不存在」',
    warns.some(m => m.includes('没有开启') && m.includes('ws')),
    warns,
    '含「没有开启 ... ws」',
  )
  check(
    'WS：没开 ws 的情况也不交给框架（避免把 token 打进日志）',
    fwUpgrades.length === before,
    fwUpgrades.slice(before),
    [],
  )

  wsSrv.close()
}

/* ---------- 收尾 ---------- */
server.close()
for (const s of Object.values(BACKENDS))
  try {
    s.close()
  } catch {
    /* ignore */
  }

if (cfgBackup) fs.writeFileSync(CFG_FILE, cfgBackup)
else if (fs.existsSync(CFG_FILE)) fs.unlinkSync(CFG_FILE)

fs.rmSync(SANDBOX, { recursive: true, force: true })
const failed = check.summary('端到端 ')
process.exit(failed ? 1 : 0)
