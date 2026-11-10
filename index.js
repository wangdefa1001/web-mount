import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../../lib/plugins/plugin.js'
import { state, collectStatus, resetStats, statOf, touchTraffic } from './lib/status.js'
import {
  ensureConfig,
  configPaths,
  readConfigFile,
  normalizeConfig,
  readSettings,
  saveFromEditor,
  readEditorData,
} from './lib/config.js'
import {
  sortRoutes,
  findRoute,
  routeMatches,
  expandAutoApi,
  pathnameOf,
  queryOf,
  subPath,
  joinPath,
  refContext,
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
} catch {
  /* 非 ESM 环境回退到 cwd */
}
const CFG_PATHS = configPaths(pluginDir)
const configPath = CFG_PATHS.file

/* WS 侧的告警节流：同一条路径 10 秒内只提示一次，避免面板轮询把日志刷爆 */
function wsWarn(key, msg) {
  const now = Date.now()
  if (now - (state.wsWarnAt.get(key) || 0) < 10000) return
  state.wsWarnAt.set(key, now)
  logger.warn(msg)
}

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
      save: data => {
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
    state.firstRun = ensureConfig(pluginDir, logger)
    const raw = readConfigFile(pluginDir, logger)
    if (!raw) logger.error('[web-mount] 读取 config.json 失败（将使用空路由）')
    const cfg = normalizeConfig(raw || {})

    state.settings = readSettings(cfg)

    const all = cfg.routes || []
    state.allRoutes = all
    // enabled：配置里启用且端口有效的条目；derived：由 autoApi 派生的 /api 分流
    const enabled = all.filter(r => r.enable && r.port)
    const effective = expandAutoApi(enabled)
    // routes：匹配用，最长路径优先。端口非法的条目在这里被排除，
    // 但 allRoutes 里仍保留（带 __invalidPort 标记），启动日志会点名。
    state.routes = sortRoutes(effective)
    // displayRoutes：展示用，保持配置里的原始顺序（派生路由追加在末尾）
    state.displayRoutes = effective
    state.wsRoutes = state.routes.filter(r => r.ws)

    this.syncQuietLog()

    if (isReload) {
      logger.mark(`[web-mount] 配置已热重载，当前生效 ${state.routes.length} 条路由`)
    }
    if (state.firstRun) {
      // 首次安装：模板里没有预置路由（免得把别人的端口抄进自己的配置），
      // 这里直接把入口给出来，省得去翻文档找状态页地址
      logger.mark(`[web-mount] 首次运行，配置已生成（还没有任何挂载）。打开 ${STATUS_PATH} 添加第一条路由`)
    }
    return cfg
  }

  /* ---------- 把插件接管的路径从 Yunzai 框架的 HTTP 日志里降级 ---------- *
   * 框架 lib/bot.js 的 serverHandle 会对每个请求打一条：
   *   [http://host/path <= ip] HTTP GET 请求 { headers: {...} }
   * 里面是整个 req.headers —— 包括 authorization 里的 Bearer Token。
   * 被我们代理走的请求本来就有 web-mount 自己的访问日志，不必再往框架日志里
   * 抄一遍请求头（还会把面板的 Token 落到日志文件里）。
   *
   * 框架的做法是：quiet 数组里的前缀命中时，日志从 mark 降级为 debug。
   * 这里只往里塞「我们自己接管的路径」，不动别的路由，热重载时精确撤销。
   * 老版本 Yunzai（没有这个数组）静默跳过。
   * ------------------------------------------------------------------ */
  syncQuietLog() {
    const quiet = Bot.express && Bot.express.quiet
    if (!Array.isArray(quiet)) return

    for (const p of state.quietPaths || []) {
      const i = quiet.indexOf(p)
      if (i !== -1) quiet.splice(i, 1)
    }
    state.quietPaths = []

    if (!state.settings.quietProxyLog) return

    const want = new Set()
    for (const r of state.routes) {
      // '/' 兜底会静音整站日志，绝不能加
      if (r.matchPath && r.matchPath !== '/') want.add(r.matchPath)
    }
    if (state.settings.statusPage) want.add(STATUS_PATH)

    for (const p of want) {
      if (quiet.includes(p)) continue
      quiet.push(p)
      state.quietPaths.push(p)
    }
  }

  // 监听 config.json 修改时间，实现保存即生效(免重启)
  startWatcher() {
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    if (!state.settings.autoReload) return

    let lastMtime = 0
    try {
      lastMtime = fs.statSync(configPath).mtimeMs
    } catch {
      /* ignore */
    }

    state.timer = setInterval(() => {
      if (!state.settings.autoReload) return
      let m = 0
      try {
        m = fs.statSync(configPath).mtimeMs
      } catch {
        return
      }
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

  /* ---------- WebSocket upgrade 接管 ---------- *
   * 为什么要把已有的 upgrade 监听摘下来自己分发，而不是再挂一个监听：
   * Yunzai 的 lib/bot.js 里 wsConnect 对「首段路径不是已注册 WS 处理器」的握手
   * 会回一句 404 并把 socket 销毁，还会把整个 req.headers（含 token）打进日志。
   * 而 'upgrade' 是 EventEmitter：我们哪怕 prependListener 抢在最前面转发，
   * 框架那个监听随后照样会跑 —— 于是 101 已经发出去，紧接着又被追一条 404 并断链，
   * 表现就是「WS 连上就断」；没开 ws 的路由还额外把 token 漏进日志。
   * 所以这里把原有的监听保存下来，统一由我们分发：命中我们的路由就自己处理，
   * 没命中再原样交回去，框架行为完全不变。
   */
  registerWs() {
    const server = Bot.server
    if (state.wsRegistered && state.wsServer === server) return
    try {
      const previous = server.listeners('upgrade')
      server.removeAllListeners('upgrade')
      server.on('upgrade', (req, socket, head) => {
        let handled = false
        try {
          handled = this.handleUpgrade(req, socket, head)
        } catch (e) {
          logger.error('[web-mount] WS 转发异常: ' + e.message)
        }
        if (handled) return
        for (const fn of previous) {
          try {
            fn.call(server, req, socket, head)
          } catch (e) {
            logger.error('[web-mount] 交回框架的 WS 处理出错: ' + e.message)
          }
        }
      })
      state.wsServer = server
      state.wsRegistered = true
    } catch (e) {
      state.wsRegistered = false
      logger.error('[web-mount] WS 监听注册失败: ' + e.message)
    }
  }

  /* 返回 true 表示「这次 upgrade 归我们管，框架别再插手」 */
  handleUpgrade(req, socket, head) {
    if (!state.routes.length || !socket || socket.destroyed) return false
    const pathname = pathnameOf(req.url || '')
    const ref = refContext(req.headers, state.settings)

    let route = state.wsRoutes.find(r => routeMatches(r, ref, pathname, 'GET'))

    // WS 握手只带 Origin（没有页面路径），配了 matchReferer 的路由永远匹配不上。
    // 这里退一步只比路径，但仅当候选唯一时采用 —— 多候选说明真分不清该发给谁，
    // 宁可交回框架并提示，也不要把连接送错后端。
    if (!route) {
      const byPath = state.wsRoutes.filter(r => subPath(pathname, r.matchPath) !== null)
      if (byPath.length === 1) {
        route = byPath[0]
        if (state.settings.debug) {
          logger.mark(`[web-mount] WS ${pathname} 握手没有可用的来源路径，已按路径匹配到 ${route.name}`)
        }
      } else if (byPath.length > 1) {
        wsWarn(
          `ambiguous:${pathname}`,
          `[web-mount] WS ${pathname} 有多条候选路由（${byPath.map(r => r.name).join(' / ')}），`
            + '握手拿不到页面路径无法按来源分流，已放行给框架。请让各自的 WS 路径不重叠，或去掉 matchReferer',
        )
        return false
      }
    }

    if (!route) {
      // 路径属于我们挂载的后端，但该路由没开 ws：明确回 501，
      // 比让框架打一条「WebSocket 处理器 xxx 不存在」+ 整包请求头清楚得多。
      const owner = state.routes.find(r => subPath(pathname, r.matchPath) !== null)
      if (!owner) return false
      wsWarn(
        `disabled:${owner.matchPath}`,
        `[web-mount] WS 请求 ${pathname} 命中路由「${owner.name || owner.matchPath}」，`
          + '但该路由没有开启「转发 WebSocket」，已拒绝（状态页/锅巴里勾上 ws 即可）',
      )
      const body = `501 Not Implemented\n该路径的挂载没有开启 WebSocket 转发，请在 web-mount 配置里为「${owner.name || owner.matchPath}」勾选 ws\n`
      try {
        socket.write(
          'HTTP/1.1 501 Not Implemented\r\n'
            + 'content-type: text/plain; charset=utf-8\r\n'
            + `content-length: ${Buffer.byteLength(body)}\r\n`
            + 'connection: close\r\n\r\n'
            + body,
        )
        socket.end()
      } catch {
        /* socket 已断 */
      }
      return true
    }

    const sub = subPath(pathname, route.matchPath)
    const targetPath = joinPath(route.prefix, sub) + queryOf(req.url || '')
    statOf(route).count++
    touchTraffic()
    forwardWs(req, socket, head, targetPath, route)
    return true
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
    if (
      cfg.trailingSlashRedirect !== false
      && !route.matchReferer
      && !route.matchMethod
      && (method === 'GET' || method === 'HEAD')
      && route.matchPath !== '/'
      && pathname === route.matchPath
    ) {
      res.writeHead(302, { location: route.matchPath + '/' + queryOf(url) })
      return res.end()
    }

    const sub = subPath(pathname, route.matchPath)
    const proxyPath = joinPath(route.prefix, sub) + queryOf(url)
    forwardHttp(req, res, proxyPath, route)
  }

  /* ---------- 启动日志 ---------- */
  printRoutes() {
    const routes = state.displayRoutes && state.displayRoutes.length ? state.displayRoutes : state.routes
    const manual = routes.filter(r => !r.derived)
    const derived = routes.filter(r => r.derived)
    const skipped = state.allRoutes.filter(r => r.enable && !r.port)
    for (const r of manual) {
      const src = r.matchReferer ? `(来源 ${r.matchReferer})` : ''
      const mtd = r.matchMethod ? `(仅 ${r.matchMethod})` : ''
      const prefixTxt = r.prefix && r.prefix !== '/' ? r.prefix : ''
      logger.mark(
        `[web-mount] ${r.matchPath}${src}${mtd} -> ${r.host}:${r.port}${prefixTxt} 已挂载${r.ws ? '(含WS)' : ''}${r.name ? ' [' + r.name + ']' : ''}`,
      )
    }
    for (const r of derived) {
      logger.mark(`[web-mount] ${r.matchPath}(来源 ${r.matchReferer}) -> ${r.host}:${r.port}${r.prefix} 已自动生成`)
    }

    if (manual.length) {
      const list = manual.map(r => r.matchPath + (r.matchReferer ? `<${r.matchReferer}>` : '')).join(' ')
      const extra = derived.length ? `（另自动生成 ${derived.length} 条 /api 分流）` : ''
      logger.mark(`[web-mount] 启动完成，已挂载 ${manual.length} 条${extra}: ${list}`)
    } else {
      logger.warn('[web-mount] 还没有任何挂载。在状态页/锅巴里添加一条路由，或直接编辑 config.json')
    }

    if (skipped.length) {
      logger.warn(
        `[web-mount] 以下 ${skipped.length} 条因端口无效被跳过（不会转发，请检查端口）: `
          + skipped.map(r => `${r.name || r.matchPath}(port=${r.__invalidPort || r.port || '空'})`).join(' ; '),
      )
    }
    if (state.settings.statusPage) {
      const tk = state.settings.statusToken
      logger.mark(
        `[web-mount] 状态页: ${STATUS_PATH}${tk ? `（已设口令，长度 ${tk.length}）` : '（未设口令，建议公网暴露时设置）'}`,
      )
    }
    if (state.settings.autoReload) {
      logger.mark('[web-mount] 已开启配置热重载，修改 config.json 后约 2 秒自动生效')
    }
    if (state.settings.quietProxyLog && state.quietPaths.length) {
      logger.mark(
        `[web-mount] 已把 ${state.quietPaths.length} 条挂载路径的框架 HTTP 日志降级为 debug`
          + '（避免请求头里的 Token 落到日志；设 quietProxyLog:false 可还原）',
      )
    }
  }
}
