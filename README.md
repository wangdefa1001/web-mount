# web-mount

把本机各端口服务反向代理到 Yunzai 的 HTTP 端口下，**只记一个端口，用不同路径访问所有服务**。

`127.0.0.1:2536/zy` → GsCore 的 `8765`　`127.0.0.1:2536/qinglong` → 青龙的 `5700`

<p align="center">
  <img src="docs/statuspage-light.png" alt="状态页（浅色）" width="49%">
  <img src="docs/statuspage-dark.png" alt="状态页（深色）" width="49%">
</p>

## 安装

```bash
cd TRSS-Yunzai/plugins
git clone https://github.com/wangdefa1001/web-mount
```

重启 Yunzai。首次启动不带任何预置路由，日志会给出引导。

加路由有两个入口，**改的是同一份配置**：

- 打开 `http://127.0.0.1:<你的HTTP端口>/__web-mount__`
- 锅巴侧边栏「端口挂载」

想手写就改 `config/config.json`，写法参考 `config/example_routes.json`。

> 升级：`git pull` 后**重启 Yunzai**。只有配置文件支持热重载，改 JS 必须重启。

## 路由字段

| 字段                 | 说明                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `enable`             | 是否启用                                                               |
| `name`               | 名称，用于日志与入口卡片                                               |
| `matchPath`          | 浏览器访问的路径前缀，如 `/zy`                                         |
| `matchReferer`       | 来源包含此串才命中，`\|` 分隔多个；留空=不限                           |
| `matchMethod`        | 限定方法，如 `GET`；留空=不限                                          |
| `host` / `port`      | 目标主机与端口                                                         |
| `prefix`             | 目标内前缀，见下节                                                     |
| `ws`                 | 是否同时转发 WebSocket                                                 |
| `entry`              | 是否作为「服务入口」卡片：`true`/`false`/留空自动                      |
| `autoApi`            | 自动生成一条 `/api` 分流，见「自动 /api」                              |
| `refererTokenHeader` | 补凭证的请求头名，从**同源**来源页地址的 `?token=` 取值补上；留空=不补 |

最小的一条（除 `port` 外都能省）：

```json
{ "enable": true, "matchPath": "/zy", "port": 8765, "autoApi": true }
```

**优先级**：路径越长越优先；同长度时「来源真的命中」的胜出，都没命中才按配置顺序。所以多份 `/api` 分流不会互相抢。

> `matchReferer` 只比对 pathname，且默认只认同源（`refererSameOriginOnly`）。Referer 谁都能伪造，关掉等于让陌生网页把你的 `/api` 打到自己的后端。
>
> iframe 和模块脚本可能只带 Origin、不带 Referer，拿不到页面路径。这类请求会落到兜底路由，实在分不清时落配置里的第一条——不会漏回 Yunzai 变 404。想让它们精确归属，把接口路径分开就行。

## `matchPath` 与 `prefix`

**转发路径 = `prefix` + (请求路径去掉 `matchPath` 后的剩余部分)**

| matchPath   | prefix   | 访问              | 转发到         |
| ----------- | -------- | ----------------- | -------------- |
| `/memes`    | `/memes` | `/memes/a.png`    | `/memes/a.png` |
| `/zy`       | `/app`   | `/zy/x`           | `/app/x`       |
| `/qinglong` | `/`      | `/qinglong/login` | `/login`       |

`prefix: "/"` 是剥掉挂载前缀，适合青龙、NapCat 这种跑在根目录的服务。

> umi/react 打包的面板（青龙）挂到子路径会白屏：先给它设基础路径（青龙是 `QlBaseUrl=/qinglong/`），再用 `prefix: "/"` 剥前缀。面板没有基础路径配置项时，子路径代理基本无解，改用子域名反代。

## 自动 /api

面板页面挂在 `/zy` 下，但前端代码用**绝对路径** `/api/...` 发请求，到 Yunzai 时已经不含挂载前缀。在页面路由上勾选「自动 /api」即可：

```json
{ "matchPath": "/zy", "port": 8765, "prefix": "/app", "autoApi": true }
```

生成规则偏保守：同一后端的多页面合并成一条；已有手工 `/api` 路由时不生成；`/` 兜底路由不生成；派生路由不写回配置文件。

## 全局设置

| 字段                    | 默认    | 说明                                                                           |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `autoReload`            | `true`  | 改配置文件约 2 秒生效                                                          |
| `statusPage`            | `true`  | 开启 `/__web-mount__` 状态页                                                   |
| `statusToken`           | 空      | 状态页口令，设置后才允许在页面里改配置。公网暴露务必设置                       |
| `debug`                 | `false` | 每次转发打印方法、URL、状态码、耗时                                            |
| `proxyTimeout`          | `30000` | 等待后端响应的超时（毫秒）。**SSE 请求不受此限制**                             |
| `allowEmbed`            | `true`  | 允许页面被嵌进面板（转发时剥掉 `X-Frame-Options`）                             |
| `configEditor`          | `true`  | 是否允许在页面里改配置                                                         |
| `refererSameOriginOnly` | `true`  | 来源分流只认同源                                                               |
| `trailingSlashRedirect` | `true`  | 访问 `/memes` 时 302 到 `/memes/`，让 `./x.js` 相对资源解析正确                |
| `quietProxyLog`         | `true`  | 把已挂载路径从框架 HTTP 日志里降为 debug（那条日志会打出整份请求头，含 Token） |
| `quietExtraPaths`       | `[]`    | 额外降级的前缀，给没被本插件接管的吵闹请求用；只改日志级别，`/` 会被忽略       |
| `preserveHost`          | `true`  | 转发时保留客户端原始 `Host`。仅当后端只认自己的 Host 时才关                    |

## 静音日志

Yunzai 对每个请求都打一条 `HTTP GET 请求 { headers }`，会把整份请求头（含 `cookie`、`authorization`）写进日志。插件一多，这类日志能刷满整个控制台。

状态页「配置 → **静音日志**」页签专门管这个，一眼能看清哪些前缀正在生效：

| 开关                 | 作用                                                              |
| -------------------- | ----------------------------------------------------------------- |
| 静音本插件挂载的路径 | 路由表里的 `matchPath` 自动生效，默认开                           |
| 额外静音前缀         | 手填没被本插件接管的路径，逗号或换行分隔，如 `/qqbot-web, /utils` |

页签里会把「已挂载路径」直接列成标签，点一下就加进额外前缀（再点一下从列表移除），不用手打。前缀按 `startsWith` 匹配，写 `/qqbot-web` 就覆盖它下面全部。

只改日志级别，不影响转发，也不会让请求 404。唯一例外是 `/`：它等于关掉整站日志，会被忽略（界面上会标红提示）。

```json
{ "quietProxyLog": true, "quietExtraPaths": ["/qqbot-web", "/utils", "/favicon.ico"] }
```

## 页面把 token 放在 URL 上

有些现成页面（锅巴自定义页）把凭证放在自己地址的 `?token=` 上，页面代码却读错了地方，导致接口全 401。不用改它的代码，交给转发补：

| 字段                 | 值                                                            |
| -------------------- | ------------------------------------------------------------- |
| `matchPath`          | 页面实际请求的前缀，如 `/guoba-plugin-mock-root/web-page/api` |
| `prefix`             | 后端真实的接口前缀，如 `/guoba-plugin-mock-root/api/custom`   |
| `refererTokenHeader` | 后端认的请求头名，如 `guoba-access-token`                     |

`matchPath` + `prefix` 完成一次前缀替换，`refererTokenHeader` 再从来源页地址取 `token` 补进请求头。凭证只从同源来源取，客户端已带该头则不覆盖。

> `prefix` 里那段 `/guoba-plugin-mock-root`（锅巴的挂载前缀）**不能省**。漏掉会落到框架对未知 `/api/*` 的兜底，表现为 302 跳到插件市场、浏览器报跨域失败，而不是 404。

## 状态页

概览、最近 60 秒流量、可搜索的路由表、后端在线探测、服务入口卡片。装了 [guoba-plugin-next](https://gitee.com/longhengmu/guoba-plugin-next) 后锅巴侧边栏也会多一个入口，两处是同一套页面，只是鉴权不同。

顶栏三个常驻按钮（自动刷新 / 刷新 / 配置），其余在 `⋯` 里。快捷键：<kbd>R</kbd> 刷新 · <kbd>F</kbd> 搜索 · <kbd>G</kbd> 配置 · <kbd>Esc</kbd> 逐层关闭。

给脚本用的接口：

```
GET  /__web-mount__?format=json     # 完整状态（需登录，或带 x-wm-token: <口令>）
POST /__web-mount__/reload          # 重载配置
POST /__web-mount__/reset           # 清空统计
```

口令登录后下发 `wm_auth` Cookie（HttpOnly，7 天），连错 5 次锁该 IP 60 秒。

**直连后端探测**——排查「页面能开但没数据」最快的手段，绕过浏览器直接问后端：

```bash
curl -b 'wm_auth=<cookie>' \
  'http://127.0.0.1:2536/__web-mount__/probe?path=/api/base/GetSysStatusRealTime&port=6099&ms=4000'
```

`firstByteMs` 是首字节延迟，`frames` 是这段时间收到的 SSE 帧数。`frames: 0` 说明后端真没推东西，不是转发坏了。只能探测路由表里的端口，未设口令时接口关闭。

## 服务入口

每台后端聚成一张卡片，点一下在页内 iframe 打开。判断「是不是同一个页面」看 `prefix` 而不是端口（一个端口可能挂多个页面）。`entry` 留空时自动补一张；同端口想多出一张卡，直接给它标「显示」。

## 常见问题

**502 是谁返回的？**

| 日志                                         | 含义                 | 怎么办                                 |
| -------------------------------------------- | -------------------- | -------------------------------------- |
| `ECONNREFUSED`                               | 我们连不上后端       | 确认端口在监听；容器里别填 `127.0.0.1` |
| `后端返回 502 ...`（注明这是后端自己返回的） | 后端活着，它自己报错 | 查那个服务的日志                       |
| 控制台什么都没有                             | frp / nginx 加的     | 直连后端确认                           |

插件自己产生的 502，响应体是三行诊断文本；后端返回的 502，响应体是后端自己的内容。**看响应体一眼就能分清。**

**实时日志一片空白 / 系统信息全是 `-`？**
这类接口是 SSE，没有新事件时一个字节都不发。插件已跳过超时限制、注入 `: ping` 心跳、加 `X-Accel-Buffering: no`。仍有问题就用上面的 `probe` 确认后端推不推数据。

**WebSocket 连上就断？**
该路由没勾 `ws`。日志会写明「命中路由但没开启转发 WebSocket」，勾上即可。看到框架报「WebSocket 处理器 xxx 不存在」说明这条 upgrade 没被任何路由接住。

**日志里还是一堆 `HTTP GET 请求 { headers }`？**
`quietProxyLog` 只管本插件接管的路径。`/qqbot-web/api/...`、`/utils/fonts/x.woff2` 这类由别处响应的请求，到「配置 → 静音日志」里把前缀填进「额外静音前缀」即可。别写 `/`，那等于关掉整站日志。

**陌生网页能访问我的后端吗？**
默认不能，来源必须同源。不要随手关 `refererSameOriginOnly`。

**忘了状态页口令？**
在 `config/config.json` 的 `statusToken` 里。

## 在 Termux / Android 上

| 现象                      | 处理                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| 配置「整个消失」          | 已是原子写，坏文件备份为 `config.json.broken`                             |
| 全填 `127.0.0.1` 却连不上 | chroot 容器与宿主不是同一网络命名空间，改填宿主局域网 IP 或监听 `0.0.0.0` |

## 开发

```
index.js            # 入口：注册监听 / 热重载 / 启动日志
guoba.support.js    # 锅巴「插件配置」表单
guoba/              # 状态页 html/css/js（与状态页共用同一套）
lib/route.js        # 路径与匹配（纯函数，可单测）
lib/proxy.js        # HTTP / WebSocket 反向代理
lib/status-page.js  # 状态页：鉴权 / 配置接口 / 渲染
lib/config.js       # config.json 唯一读写入口（归一化 / 原子写）
lib/status.js       # 运行状态与统计
```

改转发行为动 `lib/proxy.js`，改匹配规则动 `lib/route.js`，都不用碰插件生命周期。

```bash
npm install     # eslint + prettier，仅开发需要
npm test        # 全部自检（临时目录，不碰你的配置）
npm run check   # lint + test，提交前跑这个
```

## 更新

<details>
<summary>点开历史版本</summary>

- **v1.5.18**：静音日志独立成页签，实时预览生效前缀，点标签即可增删
- **v1.5.17**：新增 `quietExtraPaths`，把没被本插件接管的吵闹请求也降级
- **v1.5.16**：修正锅巴插件页示例的 `prefix`，必须带挂载前缀
- **v1.5.15**：新增 `refererTokenHeader`，给 token 在 URL 上的现成页面补凭证
- **v1.5.14**：只有 Origin 的请求不再漏回框架；来源命中的路由优先
- **v1.5.13**：SSE 不再被超时掐断（实时日志、系统状态恢复）；WS 握手独占分发
- **v1.5.12**：新增 `/__web-mount__/probe` 直连探测接口
- **v1.5.11**：转发保留客户端 `Host`，修「页面能开但接口没数据」
- **v1.5.10**：转发超时区分「连不上」与「连上了不回」
- **v1.5.9**：转发失败附人话解释；后端已响应时不再改写状态码
- **v1.5.8**：状态页改版，毛玻璃与页内确认条
- **v1.5.7**：后端自己返回 5xx 也记日志
- **v1.5.6**：新增 `quietProxyLog`；配置模板清空预置路由
- **v1.5.5**：新增「自动 /api」；引入 eslint + prettier
- v1.5.4 及更早见 `git log`

</details>

## 许可证

[MIT](LICENSE)。随意使用、修改、分发，保留版权声明即可。

## 致谢

[Yunzai-Bot v3](https://github.com/TimeRainStarSky/Yunzai) · 锅巴面板社区
