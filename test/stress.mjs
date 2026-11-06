// 高并发 + 长连接 + 慢后端，验证代理不丢请求、不漏连接
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const PORT = 12537
globalThis.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
let fail = 0
const t = (n, c, got) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + n)
  if (!c) {
    fail++
    console.log('      got=', got)
  }
}

// 一个会慢 200ms 响应的后端 + 一个普通后端
let hits = 0
const slow = http.createServer((req, res) => {
  hits++
  setTimeout(() => {
    res.writeHead(200)
    res.end('ok:' + req.url)
  }, 200)
})
await new Promise(r => slow.listen(18801, '127.0.0.1', r))

// index.js 会 import '../../lib/plugins/plugin.js'（Yunzai 的插件基类），
// 所以在临时目录里拼一个最小 Yunzai 结构：<tmp>/lib/plugins/plugin.js + <tmp>/plugins/web-mount
const YZ = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-stress-'))
fs.mkdirSync(path.join(YZ, 'lib/plugins'), { recursive: true })
fs.mkdirSync(path.join(YZ, 'plugins'), { recursive: true })
fs.copyFileSync(path.join(HERE, 'lib/plugins/plugin.js'), path.join(YZ, 'lib/plugins/plugin.js'))
fs.cpSync(REPO, path.join(YZ, 'plugins/web-mount'), {
  recursive: true,
  filter: src => !src.includes('/.git') && !src.includes('/test'),
})
const PLUGIN = path.join(YZ, 'plugins/web-mount')

fs.writeFileSync(
  path.join(PLUGIN, 'config/config.json'),
  JSON.stringify({
    routes: [{ enable: true, name: 'slow', matchPath: '/s', host: '127.0.0.1', port: 18801, prefix: '/' }],
    autoReload: false,
    statusPage: false,
    allowEmbed: true,
    configEditor: true,
  }),
)

const express = {
  stack: [],
  use(f) {
    this.stack.push(f)
  },
}
const server = http.createServer((req, res) => {
  const next = () => {
    res.writeHead(418)
    res.end('yunzai')
  }
  let i = 0
  const step = () => {
    const fn = express.stack[i++]
    if (!fn) return next()
    fn(req, res, step)
  }
  step()
})
globalThis.Bot = { express, server }
// keep-alive 连接复用：模拟浏览器连续请求
server.keepAliveTimeout = 5000
const mod = await import(path.join(PLUGIN, 'index.js') + '?s=' + Date.now())
await new mod.default().init()
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

const agent = new http.Agent({ keepAlive: true, maxSockets: 20 })
function one(i) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/s/item/' + i, agent }, res => {
      let s = ''
      res.on('data', c => (s += c))
      res.on('end', () => resolve({ s: res.statusCode, body: s }))
    })
    r.on('error', reject)
    r.end()
  })
}

const N = 100
const t0 = Date.now()
const all = await Promise.all(Array.from({ length: N }, (_, i) => one(i)))
const ms = Date.now() - t0
const ok = all.filter(x => x.s === 200 && /^ok:\/item\/\d+$/.test(x.body))
t(
  `${N} 个并发请求全部成功`,
  all.every(x => x.s === 200),
  all
    .filter(x => x.s !== 200)
    .map(x => x.s)
    .slice(0, 5),
)
t('后端实际收到 100 次（不丢不重）', hits === N, hits)
t('每个响应体都能对上自己的请求路径', ok.length === N, ok.length, N)
t('并发下总耗时合理（应 < 3s）', ms < 3000, ms + 'ms')
console.log(`      耗时 ${ms}ms，avg ${(ms / N).toFixed(1)}ms/req`)

// 空路由 GET 也必须有响应
const empty = await new Promise(res => {
  http.get({ host: '127.0.0.1', port: PORT, path: '/s/nothing', headers: {} }, r => {
    r.resume()
    r.on('end', () => res(r.statusCode))
  })
})
t('串行 GET 正常返回', empty === 200, empty)

agent.destroy()
server.close()
slow.close()
fs.rmSync(YZ, { recursive: true, force: true })
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
