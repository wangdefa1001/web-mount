import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEditorData, saveFromEditor } from './lib/config.js'

// 用插件自身目录定位配置，避免依赖 process.cwd()
let baseDir = process.cwd()
try {
  baseDir = path.dirname(fileURLToPath(import.meta.url))
} catch {
  baseDir = path.join(process.cwd(), 'plugins/web-mount')
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
          bottomHelpMessage: '开启后访问 /__web-mount__ 查看路由、在线状态与请求统计',
        },
        {
          field: 'statusToken',
          label: '状态页口令',
          component: 'Input',
          componentProps: { placeholder: '留空=不校验；公网暴露时建议设置' },
          bottomHelpMessage: '设置后状态页会先弹出登录框；同时允许在状态页里改配置',
        },
        {
          field: 'allowEmbed',
          label: '允许嵌入',
          component: 'Switch',
          bottomHelpMessage: '开启后会把挂载的页面嵌进面板/状态页，并自动去掉后端的 X-Frame-Options',
        },
        {
          field: 'configEditor',
          label: '页面内配置',
          component: 'Switch',
          bottomHelpMessage: '是否允许在状态页/面板页面里直接改路由（锅巴面板始终可改）',
        },
        {
          field: 'refererSameOriginOnly',
          label: '来源仅限同源',
          component: 'Switch',
          bottomHelpMessage:
            '开启时（推荐）只有 Referer/Origin 与本机 Host 一致才参与来源分流。Referer 可被任意网站伪造，关掉后陌生网页也能把请求打到你的后端',
        },
        {
          field: 'trailingSlashRedirect',
          label: '补尾斜杠跳转',
          component: 'Switch',
          bottomHelpMessage:
            '访问 /memes 时 302 到 /memes/，让页面里的 ./x.js 相对资源解析正确。某些 SPA 对多次跳转敏感可关掉',
        },
        {
          field: 'debug',
          label: '调试日志',
          component: 'Switch',
          bottomHelpMessage: '开启后每次转发都会在控制台打印请求、状态码与耗时',
        },
        {
          field: 'quietProxyLog',
          label: '静音框架 HTTP 日志',
          component: 'Switch',
          bottomHelpMessage:
            '开启时（推荐）把已挂载路径从 Yunzai 自带的「HTTP GET 请求 { headers }」日志里降级为 debug —— 那条日志会把整份请求头打出来，包括面板的 Bearer Token。插件自己的转发日志不受影响',
        },
        {
          field: 'quietExtraPaths',
          label: '额外静音前缀',
          component: 'Input',
          componentProps: { placeholder: '如 /utils,/favicon.ico（逗号分隔）' },
          bottomHelpMessage:
            '给「没被本插件接管、但同样吵」的请求用：命中前缀的请求日志降级为 debug，只影响日志，不影响转发。框架按前缀匹配，写 /utils 就覆盖 /utils/ 下全部',
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
              {
                field: 'host',
                label: '目标IP',
                component: 'Input',
                required: true,
                componentProps: { placeholder: '127.0.0.1' },
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
                field: 'entry',
                label: '导航入口',
                component: 'Select',
                componentProps: {
                  placeholder: '自动',
                  options: [
                    { label: '自动判断', value: '' },
                    { label: '显示在服务入口', value: 'show' },
                    { label: '不显示', value: 'hide' },
                  ],
                },
                bottomHelpMessage:
                  '同一端口上可能挂着多个不同页面（如 GsCore 的 /zy 与它插件页 /daily-analyisis-gscore）。给每个页面各标一条「显示」即可，同端口的面板不会因此消失；留空则自动挑一个。',
              },
              {
                field: 'ws',
                label: 'WebSocket',
                component: 'Switch',
                bottomHelpMessage: '该服务需要 WS（如 NapCat 实时日志）时打开',
              },
              {
                field: 'autoApi',
                label: '自动 /api',
                component: 'Switch',
                bottomHelpMessage:
                  '页面里的前端代码用绝对路径 /api 发请求时，自动生成一条 /api 分流（来源=该页面路径），不用再手工加一条。已手工配过 /api 的后端不受影响',
              },
            ],
          },
          bottomHelpMessage: '自上而下匹配，命中第一条即转发。matchPath 相同的多条规则靠「来源」区分，更精确的放前面。',
        },
      ],
      // 字段清单、默认值、entry 三态转换统一由 lib/config.js 提供，
      // 这里不再重复维护一份（之前两处各写一遍，加字段时漏改就会「保存后丢失」）
      getConfigData() {
        return readEditorData(baseDir, logger, { entryAsView: true })
      },
      setConfigData(data, { Result }) {
        const saved = saveFromEditor(baseDir, data || {}, logger)
        const n = (saved.routes || []).filter(r => r.port).length
        const tip = data && data.autoReload ? '约 2 秒后自动生效' : '重启 Yunzai 后生效'
        return Result.ok({}, `已保存 ${n} 条路由，${tip}~`)
      },
    },
  }
}
