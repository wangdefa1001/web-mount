import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.dirname(HERE)

/**
 * 在临时目录里搭一个最小 Yunzai 结构，返回插件副本路径。
 *
 * 为什么需要：index.js 第一行就是 `import plugin from '../../lib/plugins/plugin.js'`，
 * 这是 Yunzai 插件基类的约定路径，必须让插件真的位于 `<root>/plugins/web-mount/` 下才能解析。
 * 直接跑 `node /path/to/web-mount/index.js` 会找不到模块。
 */
export function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'))
  fs.mkdirSync(path.join(root, 'lib/plugins'), { recursive: true })
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true })
  fs.copyFileSync(path.join(HERE, 'lib/plugins/plugin.js'), path.join(root, 'lib/plugins/plugin.js'))
  fs.cpSync(REPO, path.join(root, 'plugins/web-mount'), {
    recursive: true,
    filter: src => !/[\\/](\.git|test)$/.test(src) && !src.includes('node_modules'),
  })
  return { root, plugin: path.join(root, 'plugins/web-mount') }
}

export function loggerStub() {
  globalThis.logger = {
    mark: (...a) => console.log('  [log]', ...a),
    info: (...a) => console.log('  [log]', ...a),
    warn: (...a) => console.log('  [warn]', ...a),
    error: (...a) => console.log('  [err]', ...a),
    debug: () => {},
  }
}

export function makeChecker() {
  const results = []
  const check = (name, pass, got, expect) => {
    results.push({ name, pass })
    console.log(`${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`)
    if (!pass) console.log(`       got    = ${JSON.stringify(got)}\n       expect = ${JSON.stringify(expect)}`)
  }
  check.summary = (label = '') => {
    const bad = results.filter(r => !r.pass)
    console.log(`\n${label}共 ${results.length} 项：通过 ${results.length - bad.length}，失败 ${bad.length}`)
    for (const b of bad) console.log('  ✗ ' + b.name)
    return bad.length
  }
  return check
}
