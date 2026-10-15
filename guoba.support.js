import fs from 'node:fs'
import path from 'node:path'

const configDir = path.join(process.cwd(), 'plugins/web-mount/config')
const configPath = path.join(configDir, 'config.json')

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return {} }
}

function writeConfig(data) {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2))
}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'web-mount',
      title: '端口挂载',
      author: '@wangdefa1001',
      isV3: true,
      isV2: false,
      description: '把本机各端口的服务反向代理到 Yunzai HTTP 端口的路径下，支持按来源/路径智能分发',
      icon: 'mdi:lan-connect',
      iconColor: '#52c41a',
    },
    configInfo: {
      schemas: [
        {
          label: '路由规则（一行一条，自上而下匹配，命中第一条即转发；保存后重启 Yunzai 生效）',
          component: 'SOFT_GROUP_BEGIN',
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
              { field: 'matchPath', label: '匹配路径 matchPath', component: 'Input', componentProps: { placeholder: '/api 或 /login 或 /memes' }, required: true, bottomHelpMessage: '浏览器请求的 URL 路径前缀。同一路径可建多条，用「来源」区分' },
              { field: 'matchReferer', label: '来源包含 matchReferer', component: 'Input', componentProps: { placeholder: '/zy|/app  多个用 | 分隔, 留空=不限制' }, bottomHelpMessage: 'Referer/Origin 含此字符串才命中；用于同一路径分流到不同后端' },
              { field: 'host', label: '目标IP', component: 'Input', componentProps: { placeholder: '127.0.0.1' }, required: true },
              { field: 'port', label: '目标端口', component: 'InputNumber', componentProps: { min: 1, max: 65535 }, required: true },
              { field: 'prefix', label: '目标内前缀', component: 'Input', componentProps: { placeholder: '服务内部的路径前缀，如 /app' } },
              { field: 'ws', label: 'WebSocket', component: 'Switch', bottomHelpMessage: '该服务需要 WS(如 NapCat 实时日志)时打开' },
            ],
          },
          bottomHelpMessage: '提示：matchPath 相同的多条规则靠「来源」区分；「来源」更精确/更重要的规则放在前面。',
        },
      ],
      getConfigData() {
        const cfg = readConfig()
        return { routes: cfg.routes || [] }
      },
      setConfigData(data, { Result }) {
        const routes = (data.routes || []).map(r => ({
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
        return Result.ok({}, '保存成功，重启 Yunzai 后生效~')
      },
    },
  }
}
