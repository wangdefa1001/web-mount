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

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(data) {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2))
}

export function supportGuoba() {
  return {
    pluginInfo: {
      // 唯一标识，需与 package.json 的 name 一致
      name: 'web-mount',
      title: '端口挂载',
      description: '把本机各端口的服务反向代理到 Yunzai HTTP 端口的路径下，支持按路径/来源智能分发与 WebSocket',
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
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '路由规则',
        },
        {
          field: 'routes',
          label: '路由列表',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: 'enable',
                label: '启用',
                component: 'Switch',
                componentProps: { checkedChildren: '开', unCheckedChildren: '关' },
              },
              {
                field: 'name',
                label: '名称',
                component: 'Input',
                componentProps: { placeholder: 'meme站 / GsCore / NapCat / 青龙' },
              },
              {
                field: 'matchPath',
                label: '匹配路径 matchPath',
                component: 'Input',
                required: true,
                componentProps: { placeholder: '/api 或 /login 或 /memes' },
                bottomHelpMessage: '浏览器请求的 URL 路径前缀。同一路径可建多条，用「来源」区分',
              },
              {
                field: 'matchReferer',
                label: '来源包含 matchReferer',
                component: 'Input',
                componentProps: { placeholder: '/zy|/app   多个用 | 分隔，留空=不限制' },
                bottomHelpMessage: 'Referer/Origin 含此字符串才命中；用于同一路径分流到不同后端',
              },
              {
                field: 'host',
                label: '目标IP',
                component: 'Input',
                required: true,
                componentProps: { placeholder: '127.0.0.1' },
                bottomHelpMessage: '一般是 127.0.0.1；容器内可用宿主内网 IP',
              },
              {
                field: 'port',
                label: '目标端口',
                component: 'InputNumber',
                required: true,
                componentProps: { min: 1, max: 65535, placeholder: 3132 },
              },
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
                componentProps: { checkedChildren: '开', unCheckedChildren: '关' },
                bottomHelpMessage: '该服务需要 WS（如 NapCat 实时日志）时打开',
              },
            ],
          },
          bottomHelpMessage: '自上而下匹配，命中第一条即转发。matchPath 相同的多条规则靠「来源」区分，更精确的放前面。保存后需重启 Yunzai 生效。',
        },
      ],
      getConfigData() {
        const cfg = readConfig()
        return { routes: Array.isArray(cfg.routes) ? cfg.routes : [] }
      },
      setConfigData(data, { Result }) {
        const routes = (data.routes || [])
          .filter(r => r && (r.matchPath || r.port))
          .map(r => ({
            enable: !!r.enable,
            name: r.name || '',
            matchPath: r.matchPath || '/',
            matchReferer: r.matchReferer || '',
            host: r.host || '127.0.0.1',
            port: Number(r.port) || 0,
            prefix: r.prefix || '',
            ws: !!r.ws,
          }))
        writeConfig({ routes })
        return Result.ok({}, `已保存 ${routes.length} 条路由，重启 Yunzai 后生效~`)
      },
    },
  }
}
