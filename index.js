import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../../lib/plugins/plugin.js'
import { state, collectStatus, resetStats, statOf, touchTraffic } from './lib/status.js'
import {
  ensureConfig, configPaths, readConfigFile,
  normalizeConfig, readSettings, saveFromEditor, readEditorData,
} from './lib/config.js'
import {
  sortRoutes, findRoute, routeMatches,
  pathnameOf, queryOf, subPath, joinPath, refContext,
} from './lib/route.js'
import { forwardHttp, forwardWs } from './lib/proxy.js'
import { StatusPage, STATUS_PATH, isStatusPath } from './lib/status-page.js'

/* ------------------------------------------------------------------ *
 * 插件主类：只负责「装配」——
 *   - 启动时读配置，把路由装进运行时状态
 *   - 把中间件 / upgrade 监听注册到 Yunzai 的 HTTP 服务上
 *   - 热重载与启动日志
 *
 * 具体逻辑分在三个模块里，改哪块碰哪块：
 *   lib/route.js        路径与匹配（纯函数，可单测）
 *   lib/proxy.js        HTTP / WS 反向代理
 *   lib/status-page.js  状态页、鉴权、配置接口
 * ------------------------------------------------------------------ */

/* ---------- 路径定位 ---------- */
let pluginDir = path.join(process.cwd(), 'plugins/web-mount')
try {
  pluginDir = path.dirname(fileURLToPath(import.meta.url))
} catch { /* 非 ESM 环境回退到 cwd */ }
const CFG_PATHS = configPaths(pluginDir)
const configPath = CFG_PATHS.file

export default class WebMount extends plugin {
  constructor() {
    super({ name: 'web-mount' })
  }

  async init() {
    if (!Bot.express || !Bot.server) {
      logger.warn('[web-mount] 未检测到 Bot.express / Bot.server，插件未生效（请确认 Yunzai 的 HTTP 服务已开启）')
      return false
    }

    this.status = new StatusPage({ pluginDir, reload: () => this.reloadConfig(true) })

    this.reloadConfig(false)

    // 暴露给锅巴扩展页面(guoba/index.js)调用，两者共用同一份运行时状态
    globalThis.__webMountApi = {
      reload: () => {
        this.reloadConfig(true)
        return state.routes.length
      },
      collect: () => collectStatus(),
      reset: () => resetStats(),
      editor: () => readEditorData(pluginDir, logger),
      save: (data) => {
        saveFromEditor(pluginDir, data, logger)
        this.reloadConfig(true)
        return state.routes.length
      },
      stats: () => ({ routes: state.routes.length, startedAt: state.startedAt }),
    }

    this.registerHttp()
    this.registerWs()
    this.startWatcher()
    this.printRoutes()

    return true
  }

  /* ---------- 配置加载 / 热重载 ---------- */
  reloadConfig(isReload) {
    ensureConfig(pluginDir, logger)
    const raw = readConfigFile(pluginDir, logger)
    if (!raw) logger.error('[web-mount] 读取 config.json 失败（将使用空路由）')
    const cfg = normalizeConfig(raw || {})

    state.settings = readSettings(cfg)

    const all = cfg.routes || []
    state.allRoutes = all
    // routes：匹配用，最长路径优先。端口非法的条目在这里被排除，
    // 但 allRoutes 里仍保留（带 __invalidPort 标记），启动日志会点名。
    state.routes = sortRoutes(all.filter(r => r.enable && r.port))
    // displayRoutes：展示用，保持配置里的原始顺序
    state.displayRoutes = all.filter(r => r.enable && r.port)
    state.wsRoutes = state.routes.filter(r => r.ws)

    if (isReload) {
      logger.mark(`[web-mount] 配置已热重载，当前生效 ${state.routes.length} 条路由`)
    }
    return cfg
  }

  // 监听 config.json 修改时间，实现保存即生效(免重启)
  startWatcher() {
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    if (!state.settings.autoReload) return

    let lastMtime = 0
    try { lastMtime = fs.statSync(configPath).mtimeMs } catch { /* ignore */ }

    state.timer = setInterval(() => {
      if (!state.settings.autoReload) return
      let m = 0
      try { m = fs.statSync(configPath).mtimeMs } catch { return }
      if (m && m !== lastMtime) {
        lastMtime = m
        // 稍等写入落盘再读
        setTimeout(() => {
          try {
            this.reloadConfig(true)
          } catch (e) {
            logger.error('[web-mount] 热重载失败: ' + e.message)
          }
        }, 120)
      }
    }, 2000)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  /* ---------- HTTP 中间件注册(防热重载重复挂载) ---------- */
  registerHttp() {
    if (state.httpRegistered) return
    state.httpRegistered = true
    try {
      Bot.express.use((req, res, next) => this.handle(req, res, next))
    } catch (e) {
      state.httpRegistered = false
      logger.error('[web-mount] HTTP 中间件注册失败: ' + e.message)
    }
  }

  /* ---------- WebSocket upgrade 注册 ---------- */
  registerWs() {
    if (state.wsRegistered) return
    state.wsRegistered = true
    try {
      Bot.server.prependListener('upgrade', (req, socket, head) => {
        if (!state.wsRoutes.length) return
        const pathname = pathnameOf(req.url || '')
        // 只在这个子集里匹配 WS 路由（wsRoutes 已按最长路径优先排好）
        const ref = refContext(req.headers, state.settings)
        const route = state.wsRoutes.find(r => routeMatches(r, ref, pathname, 'GET'))
        if (!route) return
        const sub = subPath(pathname, route.matchPath)
        const targetPath = joinPath(route.prefix, sub) + queryOf(req.url || '')
        statOf(route).count++
        touchTraffic()
        forwardWs(req, socket, head, targetPath, route)
      })
    } catch (e) {
      state.wsRegistered = false
      logger.error('[web-mount] WS 监听注册失败: ' + e.message)
    }
  }

  /* ---------- 请求分流：状态页 → 路由匹配 → 转发 ---------- */
  handle(req, res, next) {
    const url = req.originalUrl || req.url || '/'
    const pathname = pathnameOf(url)
    const cfg = state.settings

    // 内置状态页(优先于所有路由)
    if (cfg.statusPage && isStatusPath(pathname)) {
      this.status.handle(req, res, url, pathname).catch(e => {
        logger.error('[web-mount] 状态页处理失败: ' + e.message)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('状态页内部错误: ' + e.message)
      })
      return
    }

    if (!state.routes.length) return next()

    const ref = refContext(req.headers, cfg)
    const method = (req.method || 'GET').toUpperCase()

    const route = findRoute(state.routes, pathname, ref, method)
    if (!route) return next()

    // 精确命中且无尾斜杠的 GET：补一个 /，否则页面里的相对资源(./x.js)会解析错。
    // 只对「没有来源/方法限制」的路由做（那条路由就是页面根），避免把分流请求也跳走。
    // 某些 SPA 对多一次跳转敏感，可用 trailingSlashRedirect: false 关掉。
    if (cfg.trailingSlashRedirect !== false &&
        !route.matchReferer && !route.matchMethod && (method === 'GET' || method === 'HEAD') &&
        route.matchPath !== '/' && pathname === route.matchPath) {
      res.writeHead(302, { location: route.matchPath + '/' + queryOf(url) })
      return res.end()
    }

    const sub = subPath(pathname, route.matchPath)
    const proxyPath = joinPath(route.prefix, sub) + queryOf(url)
    forwardHttp(req, res, proxyPath, route)
  }

  /* ---------- 启动日志 ---------- */
  printRoutes() {
    const routes = (state.displayRoutes && state.displayRoutes.length) ? state.displayRoutes : state.routes
    const skipped = state.allRoutes.filter(r => r.enable && !r.port)
    for (const r of routes) {
      const src = r.matchReferer ? `(来源 ${r.matchReferer})` : ''
      const mtd = r.matchMethod ? `(仅 ${r.matchMethod})` : ''
      const prefixTxt = r.prefix && r.prefix !== '/' ? r.prefix : ''
      logger.mark(
        `[web-mount] ${r.matchPath}${src}${mtd} -> ${r.host}:${r.port}${prefixTxt} 已挂载${r.ws ? '(含WS)' : ''}${r.name ? ' [' + r.name + ']' : ''}`
      )
    }

    if (routes.length) {
      const list = routes.map(r => r.matchPath + (r.matchReferer ? `<${r.matchReferer}>` : '')).join(' ')
      logger.mark(`[web-mount] 启动完成，已挂载 ${routes.length} 条: ${list}`)
    } else {
      logger.warn('[web-mount] 没有可用的路由，请在 config.json 或锅巴面板里添加')
    }

    if (skipped.length) {
      logger.warn(`[web-mount] 以下 ${skipped.length} 条因端口无效被跳过（不会转发，请检查端口）: ` +
        skipped.map(r => `${r.name || r.matchPath}(port=${r.__invalidPort || r.port || '空'})`).join(' ; '))
    }
    if (state.settings.statusPage) {
      const tk = state.settings.statusToken
      logger.mark(`[web-mount] 状态页: ${STATUS_PATH}${tk ? `（已设口令，长度 ${tk.length}）` : '（未设口令，建议公网暴露时设置）'}`)
    }
    if (state.settings.autoReload) {
      logger.mark('[web-mount] 已开启配置热重载，修改 config.json 后约 2 秒自动生效')
    }
  }
}
