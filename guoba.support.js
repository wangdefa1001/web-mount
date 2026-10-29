import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 用插件自身目录定位配置，避免依赖 process.cwd()
let baseDir = process.cwd()
try {
  baseDir = path.dirname(fileURLToPath(import.meta.url))
} catch {
  baseDir = path.join(process.cwd(), 'plugins/web-mount')
}
const configDir = path.join(baseDir, 'config')
const configPath = path.join(configDir, 'config.json')

const DEFAULT_SETTINGS = {
  debug: false,
  autoReload: true,
  statusPage: true,
  statusToken: '',
  proxyTimeout: 30000,
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

// 合并写回：保留文件里其它未知字段，避免保存配置时把全局设置抹掉
function writeConfig(patch) {
  const old = readConfig()
  const next = { ...(old && typeof old === 'object' ? old : {}), ...patch }
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2))
}

function normRoute(r) {
  return {
    enable: !!r.enable,
    name: typeof r.name === 'string' ? r.name.trim() : '',
    matchPath: typeof r.matchPath === 'string' && r.matchPath.trim() ? r.matchPath.trim() : '/',
    matchReferer: typeof r.matchReferer === 'string' ? r.matchReferer.trim() : '',
    matchMethod: typeof r.matchMethod === 'string' ? r.matchMethod.trim().toUpperCase() : '',
    host: typeof r.host === 'string' && r.host.trim() ? r.host.trim() : '127.0.0.1',
    port: Number(r.port) || 0,
    prefix: typeof r.prefix === 'string' ? r.prefix.trim() : '',
    ws: !!r.ws,
  }
}

export function supportGuoba() {
  return {
    pluginInfo: {
      // 唯一标识，需与 package.json 的 name 一致
      name: 'web-mount',
      title: '端口挂载',
      description: '把本机各端口的服务反向代理到 Yunzai HTTP 端口的路径下，支持按路径/来源/方法智能分发与 WebSocket',
      author: '@wangdefa1001',
      authorLink: 'https://github.com/wangdefa1001',
      link: 'https://github.com/wangdefa1001/web-mount',
      isV3: true,
      isV2: false,
      // 设为 true，即使只有 1 个配置项也显示在左侧菜单（auto 需 ≥3 个配置项才显示）
      showInMenu: true,
      icon: 'mdi:lan-connect',
      iconColor: '#52c41a',
    },
    // 注意：锅巴按「单个配置对象」读取 configInfo（直接取 configInfo.getConfigData），
    // 不能写成数组，否则会报“该插件没有配置getConfigData”
    configInfo: {
      schemas: [
        // 老版本锅巴只支持 SOFT_GROUP_BEGIN（无 SOFT_GROUP_END），
        // 分组从 BEGIN 开始持续到结束；加 END 会提示「当前面板暂不支持组件[SOFT_GROUP_END]」
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '端口挂载',
        },
        {
          field: 'autoReload',
          label: '配置热重载',
          component: 'Switch',
          bottomHelpMessage: '开启后修改/保存配置约 2 秒自动生效，无需重启 Yunzai',
        },
        {
          field: 'statusPage',
          label: '状态页',
          component: 'Switch',
          bottomHelpMessage: '开启后访问 /__web-mount__ 查看所有路由、后端在线状态与请求统计',
        },
        {
          field: 'statusToken',
          label: '状态页口令',
          component: 'Input',
          componentProps: { placeholder: '留空=不校验；公网暴露时建议设置' },
          bottomHelpMessage: '设置后需用 /__web-mount__?token=xxx 访问',
        },
        {
          field: 'debug',
          label: '调试日志',
          component: 'Switch',
          bottomHelpMessage: '开启后每次转发都会在控制台打印请求、状态码与耗时',
        },
        {
          field: 'proxyTimeout',
          label: '转发超时(ms)',
          component: 'InputNumber',
          componentProps: { min: 1000, max: 600000 },
          bottomHelpMessage: '后端在此时间内无响应则断开，默认 30000',
        },
        {
          field: 'routes',
          label: '路由列表',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              { field: 'enable', label: '启用', component: 'Switch' },
              { field: 'name', label: '名称', component: 'Input', componentProps: { placeholder: 'meme站 / GsCore / NapCat / 青龙' } },
              {
                field: 'matchPath',
                label: '匹配路径 matchPath',
                component: 'Input',
                required: true,
                componentProps: { placeholder: '/api 或 /login 或 /memes' },
                bottomHelpMessage: '浏览器请求的 URL 路径前缀。同一路径可建多条，用「来源」区分；路径越长越优先',
              },
              {
                field: 'matchReferer',
                label: '来源包含 matchReferer',
                component: 'Input',
                componentProps: { placeholder: '/zy|/app   多个用 | 分隔，留空=不限制' },
                bottomHelpMessage: 'Referer/Origin 含此字符串才命中；用于同一路径分流到不同后端',
              },
              {
                field: 'matchMethod',
                label: '限制方法 matchMethod',
                component: 'Input',
                componentProps: { placeholder: 'GET|POST  留空=不限制' },
                bottomHelpMessage: '只在指定 HTTP 方法时命中，如只让 GET 走这个后端',
              },
              { field: 'host', label: '目标IP', component: 'Input', required: true, componentProps: { placeholder: '127.0.0.1' } },
              { field: 'port', label: '目标端口', component: 'InputNumber', required: true, componentProps: { min: 1, max: 65535, placeholder: 3132 } },
              {
                field: 'prefix',
                label: '目标内前缀',
                component: 'Input',
                componentProps: { placeholder: '/app 或 /qinglong 或 /' },
                bottomHelpMessage: '转发路径 = 该前缀 + 命中后剩余路径。填 / 表示剥掉挂载前缀、映射到后端根目录',
              },
              {
                field: 'ws',
                label: 'WebSocket',
                component: 'Switch',
                bottomHelpMessage: '该服务需要 WS（如 NapCat 实时日志）时打开',
              },
            ],
          },
          bottomHelpMessage: '自上而下匹配，命中第一条即转发。matchPath 相同的多条规则靠「来源」区分，更精确的放前面。',
        },
      ],
      getConfigData() {
        const cfg = readConfig() || {}
        return {
          autoReload: cfg.autoReload === undefined ? DEFAULT_SETTINGS.autoReload : !!cfg.autoReload,
          statusPage: cfg.statusPage === undefined ? DEFAULT_SETTINGS.statusPage : !!cfg.statusPage,
          statusToken: typeof cfg.statusToken === 'string' ? cfg.statusToken : '',
          debug: !!cfg.debug,
          proxyTimeout: Number(cfg.proxyTimeout) || DEFAULT_SETTINGS.proxyTimeout,
          routes: Array.isArray(cfg.routes) ? cfg.routes : [],
        }
      },
      setConfigData(data, { Result }) {
        const routes = (data.routes || [])
          .filter(r => r && (r.matchPath || r.port))
          .map(normRoute)

        const timeout = Number(data.proxyTimeout)
        writeConfig({
          autoReload: !!data.autoReload,
          statusPage: !!data.statusPage,
          statusToken: typeof data.statusToken === 'string' ? data.statusToken.trim() : '',
          debug: !!data.debug,
          proxyTimeout: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600000) : DEFAULT_SETTINGS.proxyTimeout,
          routes,
        })

        const tip = data.autoReload ? '已保存，约 2 秒后自动生效' : '已保存，重启 Yunzai 后生效'
        return Result.ok({}, `已保存 ${routes.length} 条路由，${tip}~`)
      },
    },
  }
}
