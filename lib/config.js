import fs from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ *
 * config.json 的唯一读写入口。
 * index.js / guoba.support.js / guoba/index.js / 状态页配置区 都走这里，
 * 保证「保存」时不会互相覆盖字段。
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  debug: false,
  autoReload: true,
  statusPage: true,
  statusToken: '',
  proxyTimeout: 30000,
  // 允许把挂载的页面嵌进面板/状态页（会剥掉后端的 X-Frame-Options）
  allowEmbed: true,
  // 是否允许在页面里改配置
  configEditor: true,
}

export function normPort(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 0
}

export function normStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

// 路径归一化：补前导 /、去掉尾部多余 /
export function normPath(p) {
  let s = normStr(p)
  if (!s) return ''
  if (s !== '/' && !s.startsWith('/')) s = '/' + s
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  return s
}

export function normalizeRoute(r) {
  const matchPath = normPath(r && r.matchPath) || '/'
  const out = {
    enable: !!r.enable,
    name: normStr(r.name) || (matchPath + (r.matchReferer ? ' [' + normStr(r.matchReferer) + ']' : '')),
    matchPath,
    matchReferer: normStr(r.matchReferer),
    matchMethod: normStr(r.matchMethod).toUpperCase(),
    host: normStr(r.host) || '127.0.0.1',
    port: normPort(r.port),
    prefix: normPath(r.prefix) || '/',
    ws: !!r.ws,
  }
  // entry 三态：true/'show'=指定入口 / false/'hide'=不参与导航 / 其它=自动判断
  if (r && r.entry !== undefined && r.entry !== null && r.entry !== '') {
    const e = r.entry
    if (e === true || e === 1 || e === 'show' || e === '1') out.entry = true
    else if (e === false || e === 0 || e === 'hide' || e === '0') out.entry = false
  }
  return out
}

// 保留 raw 里的其它顶层字段，只替换 routes，避免保存时把全局设置抹掉
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { routes: [] }
  const base = { ...raw }

  if (Array.isArray(raw.routes)) {
    base.routes = raw.routes.map(normalizeRoute).filter(r => r.port)
    return base
  }

  // 旧格式：由 mounts + dispatch 迁移为统一 routes
  const routes = []
  for (const m of raw.mounts || []) {
    routes.push(normalizeRoute({
      enable: m.enable, name: m.note, matchPath: m.path, matchReferer: '',
      host: m.host, port: m.port, prefix: m.prefix, ws: m.ws,
    }))
  }
  const d = raw.dispatch || {}
  if (d.enable) {
    const dp = normPath(d.path) || '/api'
    for (const r of d.rules || []) {
      routes.push(normalizeRoute({
        enable: r.enable, name: r.name, matchPath: dp,
        matchReferer: r.matchReferer || '', host: r.host, port: r.port, prefix: r.prefix,
      }))
    }
    const f = d.fallback || {}
    if (f.enable && normPort(f.port)) {
      routes.push(normalizeRoute({
        enable: true, name: '兜底', matchPath: dp, matchReferer: '', host: f.host, port: f.port, prefix: f.prefix,
      }))
    }
  }
  base.routes = routes.filter(r => r.port)
  return base
}

/* ---------- 读写 ---------- */
export function configPaths(pluginDir) {
  const dir = path.join(pluginDir, 'config')
  return {
    dir,
    file: path.join(dir, 'config.json'),
    template: path.join(dir, 'default_config.json'),
  }
}

export function ensureConfig(pluginDir, logger) {
  const p = configPaths(pluginDir)
  try {
    if (!fs.existsSync(p.file) && fs.existsSync(p.template)) {
      fs.mkdirSync(p.dir, { recursive: true })
      fs.copyFileSync(p.template, p.file)
      logger?.info?.('[web-mount] 未找到 config.json，已从 default_config.json 复制模板')
    }
  } catch (e) {
    logger?.error?.('[web-mount] 复制默认配置失败: ' + e.message)
  }
}

export function readConfigFile(pluginDir) {
  const p = configPaths(pluginDir)
  try {
    return JSON.parse(fs.readFileSync(p.file, 'utf8'))
  } catch {
    return null
  }
}

// 合并写回：只覆盖传入的字段，其余原样保留
export function writeConfigFile(pluginDir, patch) {
  const p = configPaths(pluginDir)
  const old = readConfigFile(pluginDir)
  const next = { ...(old && typeof old === 'object' ? old : {}), ...patch }
  fs.mkdirSync(p.dir, { recursive: true })
  fs.writeFileSync(p.file, JSON.stringify(next, null, 2))
  return next
}

/* ---------- 全局设置 ---------- */
export function readSettings(cfg) {
  const c = cfg || {}
  const timeout = Number(c.proxyTimeout)
  return {
    debug: !!c.debug,
    autoReload: c.autoReload === undefined ? true : !!c.autoReload,
    statusPage: c.statusPage === undefined ? true : !!c.statusPage,
    statusToken: normStr(c.statusToken),
    proxyTimeout: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600000) : DEFAULT_SETTINGS.proxyTimeout,
    allowEmbed: c.allowEmbed === undefined ? true : !!c.allowEmbed,
    configEditor: c.configEditor === undefined ? true : !!c.configEditor,
  }
}

/**
 * 保存配置区提交的数据。
 * data = { debug, autoReload, statusPage, statusToken, proxyTimeout, allowEmbed, configEditor, routes[] }
 * 只处理出现的字段，未出现的保持原值。
 */
export function saveFromEditor(pluginDir, data) {
  const patch = {}
  const d = data || {}
  if ('debug' in d) patch.debug = !!d.debug
  if ('autoReload' in d) patch.autoReload = !!d.autoReload
  if ('statusPage' in d) patch.statusPage = !!d.statusPage
  if ('statusToken' in d) patch.statusToken = normStr(d.statusToken)
  if ('proxyTimeout' in d) {
    const t = Number(d.proxyTimeout)
    patch.proxyTimeout = Number.isFinite(t) && t >= 1000 ? Math.min(t, 600000) : DEFAULT_SETTINGS.proxyTimeout
  }
  if ('allowEmbed' in d) patch.allowEmbed = !!d.allowEmbed
  if ('configEditor' in d) patch.configEditor = !!d.configEditor
  if (Array.isArray(d.routes)) {
    patch.routes = d.routes
      .filter(r => r && (r.matchPath || r.port))
      .map(normalizeRoute)
      .filter(r => r.port)
  }
  return writeConfigFile(pluginDir, patch)
}

// 给前端/接口用的可编辑视图（不回传无关字段）
export function readEditorData(pluginDir) {
  const raw = normalizeConfig(readConfigFile(pluginDir) || {})
  return {
    ...readSettings(raw),
    routes: raw.routes || [],
  }
}
