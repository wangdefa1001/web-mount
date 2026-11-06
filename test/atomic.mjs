import fs from 'node:fs'
import path from 'node:path'
import { readConfigFile, writeConfigFile, configPaths } from '../lib/config.js'

const DIR = '/tmp/wmbroken'
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(path.join(DIR, 'config'), { recursive: true })
const p = configPaths(DIR)
let fail = 0
const t = (n, c, got) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + n)
  if (!c) {
    fail++
    console.log('      got=', got)
  }
}

// 1. 半截 JSON：必须备份，且返回 null 不抛异常
fs.writeFileSync(p.file, '{"routes": [{"matchPath": "/a"')
let threw = false
let r
try {
  r = readConfigFile(DIR, { error() {} })
} catch {
  threw = true
}
t('半截 JSON 不抛异常', !threw, 'threw')
t('半截 JSON 返回 null', r === null, r)
t('坏文件已备份为 config.json.broken', fs.existsSync(p.file + '.broken'), fs.readdirSync(path.join(DIR, 'config')))

// 2. 文件不存在：返回 null 且不创建 .broken
fs.rmSync(p.file)
fs.rmSync(p.file + '.broken', { force: true })
t('文件不存在返回 null', readConfigFile(DIR, { error() {} }) === null, '')
t('文件不存在时不留 .broken', !fs.existsSync(p.file + '.broken'), fs.readdirSync(path.join(DIR, 'config')))

// 3. 正常写入后立即可读，且目录里不残留 tmp
writeConfigFile(DIR, { routes: [{ matchPath: '/x', port: 80 }] })
t('写入后可读回', readConfigFile(DIR, {}).routes.length === 1, '')
t(
  '无残留 tmp 文件',
  !fs.readdirSync(path.join(DIR, 'config')).some(f => f.endsWith('.tmp')),
  fs.readdirSync(path.join(DIR, 'config')),
)

// 4. 写入包含中文的配置（Termux ext4 没问题，但确认编码正确）
writeConfigFile(DIR, { routes: [{ matchPath: '/中文', name: '测试✅', port: 80 }] })
const back = readConfigFile(DIR, {})
t('中文/emoji 往返无损', back.routes[0].matchPath === '/中文' && back.routes[0].name === '测试✅', back.routes[0])

// 5. 权限：写只读目录应抛出，而不是静默成功
const ro = '/tmp/wmro'
fs.rmSync(ro, { recursive: true, force: true })
fs.mkdirSync(path.join(ro, 'config'), { recursive: true })
fs.chmodSync(path.join(ro, 'config'), 0o555)
let threw2 = false
try {
  writeConfigFile(ro, { a: 1 })
} catch {
  threw2 = true
}
fs.chmodSync(path.join(ro, 'config'), 0o755)
t('只读目录写入会抛错（不静默失败）', threw2 || process.getuid() === 0, threw2 ? 'threw' : 'root 可写，跳过')

fs.rmSync(DIR, { recursive: true, force: true })
fs.rmSync(ro, { recursive: true, force: true })
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
