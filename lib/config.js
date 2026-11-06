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
  // GET 精确命中挂载路径时补一个尾斜杠（302）。相对资源 ./x.js 要靠它才能解析对
  trailingSlashRedirect: true,
  // 来源分流只认同源 Referer/Origin：Referer 可以被任意站点伪造，
  // 关掉这个开关就会退回「子串匹配任意站点」的旧行为
  refererSameOriginOnly: true,
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

// 归一化一条路由。port 非法的**不丢弃**：保留下来但置 port=0，
// 交给 reloadConfig 过滤并在日志里点名，避免「配置写错 → 路由静静消失 → 无从排查」。
//
// 顺序很重要：`port: 'abc'` 必须走 invalid 分支，不能因为 `|| 0` 变成 0 而被当成合法端口。
export function normalizeRoute(r) {
  r = r || {}
  const matchPath = normPath(r.matchPath) || '/'
  const rawPort = r.port
  const port = normPort(rawPort)
  const portMissing = rawPort === undefined || rawPort === null || rawPort === ''
  const out = {
    enable: !!r.enable,
    name: normStr(r.name) || (matchPath + (r.matchReferer ? ' [' + normStr(r.matchReferer) + ']' : '')),
    matchPath,
    matchReferer: normStr(r.matchReferer),
    matchMethod: normStr(r.matchMethod).toUpperCase(),
    host: normStr(r.host) || '127.0.0.1',
    port,
    prefix: normPath(r.prefix) || '/',
    ws: !!r.ws,
  }
  // 无效端口标记，只用于日志提示，不写回配置文件
  if (!portMissing && !port) out.__invalidPort = String(rawPort)
  // entry 三态：true=指定入口 / false=不参与导航 / 缺省=自动判断。
  // 兼容锅巴 Select 的 'show'/'hide'、配置区的 '1'/'0'，以及中文/布尔字面量。
  if (r && r.entry !== undefined && r.entry !== null && r.entry !== '') {
    const e = typeof r.entry === 'string' ? r.entry.trim().toLowerCase() : r.entry
    if (e === true || e === 1 || e === '1' || e === 'show' || e === 'true' || e === 'on' || e === 'yes' ||
        e === '显示' || e === '显示在服务入口') {
      out.entry = true
    } else if (e === false || e === 0 || e === '0' || e === 'hide' || e === 'false' || e === 'off' || e === 'no' ||
        e === '隐藏' || e === '不显示') {
      out.entry = false
    }
  }
  return out
}

// 保留 raw 里的其它顶层字段，只替换 routes，避免保存时把全局设置抹掉
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { routes: [] }
  const base = { ...raw }

  if (Array.isArray(raw.routes)) {
    // 不再 filter(port)：端口写错的条目要留着，让启动日志能点名
    base.routes = raw.routes.map(normalizeRoute)
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
      // 规则自带 matchPath/path 时必须尊重它：老版本允许规则独立匹配，
      // 一律写成 dispatch.path 会把 /login 之类的规则静默改到 /api 下。
      routes.push(normalizeRoute({
        enable: r.enable, name: r.name,
        matchPath: normPath(r.matchPath || r.path) || dp,
        matchReferer: r.matchReferer || '', host: r.host, port: r.port, prefix: r.prefix,
        matchMethod: r.matchMethod, ws: r.ws, entry: r.entry,
      }))
    }
    const f = d.fallback || {}
    if (f.enable) {
      routes.push(normalizeRoute({
        enable: true, name: '兜底', matchPath: dp, matchReferer: '', host: f.host, port: f.port, prefix: f.prefix,
      }))
    }
  }
  base.routes = routes
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

// 读到坏文件时不要静默返回 null（那会让插件带着空路由继续跑，用户配置"消失"却不报错）。
// 先把坏文件备份一份，再返回 null，日志里能定位。
export function readConfigFile(pluginDir, logger) {
  const p = configPaths(pluginDir)
  let txt
  try {
    txt = fs.readFileSync(p.file, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') logger?.error?.(`[web-mount] 读取 config.json 失败: ${e.message}`)
    return null
  }
  try {
    return JSON.parse(txt)
  } catch (e) {
    const bak = p.file + '.broken'
    try { fs.writeFileSync(bak, txt) } catch { /* ignore */ }
    logger?.error?.(`[web-mount] config.json 不是合法 JSON（${e.message}），已备份到 config.json.broken`)
    return null
  }
}

// 原子写：先写临时文件再 rename。
// 直接 writeFileSync 覆盖时，若进程恰在写入中被杀（Termux 里被系统回收很常见），
// config.json 会变成半截 JSON，下次启动整个配置就没了。
export function writeConfigFile(pluginDir, patch, logger) {
  const p = configPaths(pluginDir)
  const old = readConfigFile(pluginDir, logger)
  const next = { ...(old && typeof old === 'object' ? old : {}), ...patch }
  fs.mkdirSync(p.dir, { recursive: true })
  const tmp = `${p.file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, p.file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
  return next
}

/* ---------- 全局设置 ---------- */
export function readSettings(cfg) {
  const c = cfg || {}
  const timeout = Number(c.proxyTimeout)
  const bool = (v, def) => (v === undefined || v === null ? def : !!v)
  return {
    debug: !!c.debug,
    autoReload: bool(c.autoReload, true),
    statusPage: bool(c.statusPage, true),
    statusToken: normStr(c.statusToken),
    proxyTimeout: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600000) : DEFAULT_SETTINGS.proxyTimeout,
    allowEmbed: bool(c.allowEmbed, true),
    configEditor: bool(c.configEditor, true),
    trailingSlashRedirect: bool(c.trailingSlashRedirect, true),
    refererSameOriginOnly: bool(c.refererSameOriginOnly, true),
  }
}

/**
 * 保存配置区提交的数据。
 * data = { debug, autoReload, statusPage, statusToken, proxyTimeout, allowEmbed, configEditor, routes[] }
 * 只处理出现的字段，未出现的保持原值。
 */
export function saveFromEditor(pluginDir, data, logger) {
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
  if ('trailingSlashRedirect' in d) patch.trailingSlashRedirect = !!d.trailingSlashRedirect
  if ('refererSameOriginOnly' in d) patch.refererSameOriginOnly = !!d.refererSameOriginOnly
  if (Array.isArray(d.routes)) {
    // 端口非法的条目允许保留在文件里（写配置的人能看到自己填错了），
    // 但内部标记 __invalidPort 不能落盘。
    patch.routes = d.routes
      .filter(r => r && (r.matchPath || r.port))
      .map(normalizeRoute)
      .map(({ __invalidPort, ...rest }) => rest)
  }
  return writeConfigFile(pluginDir, patch, logger)
}

// 给前端/接口用的可编辑视图（不回传无关字段，也不回传内部标记）
export function readEditorData(pluginDir, logger) {
  const raw = normalizeConfig(readConfigFile(pluginDir, logger) || {})
  return {
    ...readSettings(raw),
    routes: (raw.routes || []).map(({ __invalidPort, ...rest }) => rest),
  }
}
