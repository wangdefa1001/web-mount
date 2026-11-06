#!/usr/bin/env node
/**
 * 一键自检：node test/run-all.mjs
 * 依次跑四组测试，任意一组失败则整体失败（退出码 1）。
 * 不依赖任何第三方包，也不需要装 Yunzai。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  ['路由匹配（路径 / 来源 / 方法 / 优先级）', 'route.mjs'],
  ['核心逻辑与兼容性（归一化 / 迁移 / 入口聚合）', 'compat.mjs'],
  ['配置原子写入与坏文件兜底', 'atomic.mjs'],
  ['端到端：真实启动插件 + 真实 HTTP 请求', 'e2e.mjs'],
  ['并发与长连接', 'stress.mjs'],
]

let failed = 0
for (const [title, file] of suites) {
  console.log(`\n\x1b[1m▶ ${title}\x1b[0m  (${file})`)
  const r = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed++
    console.log(`\x1b[31m✗ ${file} 失败\x1b[0m`)
  }
}

console.log('\n' + '='.repeat(56))
if (failed) {
  console.log(`\x1b[31m${failed} 组测试失败\x1b[0m`)
  process.exit(1)
}
console.log('\x1b[32m全部测试通过\x1b[0m')
