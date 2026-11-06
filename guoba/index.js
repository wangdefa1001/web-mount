import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatus, resetStats } from '../lib/status.js'
import { readEditorData, saveFromEditor } from '../lib/config.js'

// plugins/web-mount/guoba/index.js -> plugins/web-mount
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 锅巴面板扩展页面（guoba-plugin-next）
 * 把 web-mount 的仪表盘挂进面板侧边栏「扩展页面」，接口自动带锅巴的登录鉴权。
 * 页面与独立状态页 /__web-mount__ 共用 lib/status.js 的同一份运行时数据。
 */
export function init(ctx) {
  const { registerPage, registerApi, logger } = ctx || {}

  if (typeof registerPage !== 'function' || typeof registerApi !== 'function') {
    logger?.warn?.('[web-mount] 锅巴版本不支持扩展页面，已跳过')
    return
  }

  registerPage({
    id: 'web-mount',
    title: '端口挂载',
    icon: 'mdi:lan-connect',
    src: 'dashboard.html',
    style: 'dashboard.css',
    script: 'dashboard.js',
    priority: 60,
  })

  const notReady = res => res.status(503).json({
    ok: false, code: 503, result: null, message: 'web-mount 插件尚未就绪，请确认插件已加载',
  })

  // 运行时状态（路由、在线探测、请求统计、站点导航）
  registerApi('get', '/data', async (req, res) => {
    if (!globalThis.__webMountApi) return notReady(res)
    const data = await collectStatus()
    res.json({ ok: true, code: 0, result: data, message: 'ok' })
  })

  // 读取可编辑配置
  registerApi('get', '/config', (req, res) => {
    if (!globalThis.__webMountApi) return notReady(res)
    try {
      res.json({ ok: true, code: 0, result: readEditorData(PLUGIN_DIR, logger), message: 'ok' })
    } catch (e) {
      res.status(500).json({ ok: false, code: 500, result: null, message: '读取配置失败：' + e.message })
    }
  })

  // 保存配置（写文件 + 立即重载）
  registerApi('post', '/config', (req, res) => {
    const api = globalThis.__webMountApi
    if (!api) return notReady(res)
    const body = req.body
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, code: 400, result: null, message: '请求体不是合法 JSON' })
    }
    try {
      saveFromEditor(PLUGIN_DIR, body, logger)
      const n = api.reload()
      res.json({ ok: true, code: 0, result: { routes: n }, message: `已保存并生效，共 ${n} 条路由` })
    } catch (e) {
      res.status(500).json({ ok: false, code: 500, result: null, message: '保存失败：' + e.message })
    }
  })

  // 重载配置（改完 config.json 不用重启）
  registerApi('post', '/reload', (req, res) => {
    const api = globalThis.__webMountApi
    if (!api) return notReady(res)
    try {
      const n = api.reload()
      res.json({ ok: true, code: 0, result: { routes: n }, message: `已重载，生效 ${n} 条` })
    } catch (e) {
      res.status(500).json({ ok: false, code: 500, result: null, message: '重载失败：' + e.message })
    }
  })

  // 清空请求统计
  registerApi('post', '/reset', (req, res) => {
    resetStats()
    res.json({ ok: true, code: 0, result: null, message: '统计已清空' })
  })

  logger?.mark?.('[web-mount] 已注册锅巴扩展页面：端口挂载')
}
