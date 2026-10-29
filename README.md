<p align="center"><strong>web-mount</strong> · Yunzai 端口挂载插件</p>

<p align="center">
  <em>把本机各端口服务反向代理挂载到 Yunzai HTTP 端口下的任意路径，锅巴面板可视化配置</em>
</p>

<p align="center">
  <a href="https://github.com/wangdefa1001/web-mount"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github"></a>
  <img alt="Yunzai v3" src="https://img.shields.io/badge/Yunzai-v3-green">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2016-green">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
</p>

---

## 📖 这是什么

`web-mount` 是一个 **Yunzai v3** 插件。它把运行在本机的其它端口服务(如三方面板、静态站、WebSocket 服务)通过 `Bot.express` 中间件 + `Bot.server` 的 `upgrade` 事件,**反向代理挂载到 Yunzai HTTP 端口下的任意路径**,并在锅巴面板里可视化配置。

一句话:**你只需要记住一个端口(Yunzai 的 HTTP 端口,比如 `127.0.0.1:2536`),通过不同的路径访问所有服务。**

---

## ✨ 特性

- **统一路由模型 `routes[]`**:一行一条规则,匹配、按来源分流都在同一张表里,没有两套规则难理解的旧设计。
- **按来源分流**:不同服务共用同一条绝对路径(最常见是 `/api`)也不打架 —— 用 `matchReferer` 按请求来源(Referer/Origin)分到不同后端。
- **按 HTTP 方法分流**:`matchMethod` 可限定只让 `GET`/`POST` 命中,例如同一路径的读接口与写接口分到不同后端。
- **最长路径优先**:`/memes` 永远优先于 `/`,不会被宽泛的兜底路由抢走;同长度时按配置顺序(保证 `/api` 分流的优先级不变)。
- **支持 WebSocket**:NapCat 实时日志、WebSocket 面板等可用 `ws: true` 开启,双向透传 + 连接清理。
- **配置热重载**:改完 `config.json` 或锅巴里点保存,约 2 秒自动生效,**不用重启 Yunzai**。
- **内置状态页**:访问 `/__web-mount__` 一眼看到所有路由、后端在线状态、累计请求/错误、最近状态码与耗时。
- **转发健壮性**:正确处理 `body-parser` 已消费请求流的情况(POST/PUT 内容不会丢)、超时保护、失败日志(同路由 10 秒限流)、`X-Forwarded-*` 追加。
- **启动全量日志**:逐条 + 汇总打印所有路由;单条无效配置只警告跳过,不中断。
- **旧格式迁移**:老版 `mounts + dispatch` 配置会自动转成 `routes[]`,升版不丢配置。
- **Git 友好**:真实配置 `config/config.json` 默认忽略,仓库提交 `config/default_config.json` 模板。

---

## 🚀 安装

```bash
cd your-yunzai/plugins
git clone <本仓库地址> web-mount
# 或直接下载 zip 解压到 plugins/web-mount
```

重启 Yunzai 即可。插件依赖 Yunzai 的 `Bot.express` 与 `Bot.server`(HTTP 服务),请确保 Yunzai 的 HTTP 端口已开启。

---

## ⚙️ 用法(锅巴面板)

打开锅巴面板 → 左侧菜单 **端口挂载**(或在「插件管理」里点 `web-mount`),在「路由列表」里增删即可。

**保存即生效**:默认开启热重载,保存后约 2 秒插件自动重载路由,不用重启 Yunzai。若把「配置热重载」关掉,则需要重启 Yunzai。

每条规则字段:

| 字段 | 说明 |
|------|------|
| `enable` | 是否启用 |
| `name` | 名称,便于辨认与日志 |
| `matchPath` | 浏览器访问的 URL 路径前缀,如 `/api`、`/login`、`/memes` |
| `matchReferer` | 请求来源(Referer/Origin)包含此字符串才命中,`\|` 分隔多个;留空=不限制 |
| `matchMethod` | 限定 HTTP 方法,如 `GET`、`POST\|PUT`;留空=不限制 |
| `host` / `port` | 目标主机 / 端口 |
| `prefix` | 目标内前缀(服务根路径,如 `/app`、`/login`) |
| `ws` | 该服务是否需要 WebSocket 转发 |

> **命中规则**:`matchPath` 必须匹配;`matchReferer` / `matchMethod` 留空则不限制,填了就要同时满足。
> **优先级**:路径**越长越优先**(`/memes` 先于 `/`);**同长度时按配置顺序**,首条命中即转发。所以 `/api` 的多条分流规则,把更精确的放前面即可。

### 全局设置

| 字段 | 默认 | 说明 |
|------|------|------|
| `autoReload` | `true` | 配置热重载,改完约 2 秒生效 |
| `statusPage` | `true` | 开启 `/__web-mount__` 状态页 |
| `statusToken` | 空 | 状态页口令;设置后需 `?token=xxx`。**公网暴露时建议设置** |
| `debug` | `false` | 每次转发打印请求、状态码、耗时 |
| `proxyTimeout` | `30000` | 转发超时(毫秒),后端卡死时自动断开 |

---

## 🔍 示例:挂载一个 GsCore 面板(端口 8765)

假设本机跑着 GsCore(面板根路径为 `/app`,接口前缀为 `/api`),你想通过 `127.0.0.1:2536` 访问它。

**1) 面板入口:**
```json
{ "enable": true, "name": "GsCore面板", "matchPath": "/zy", "matchReferer": "", "host": "127.0.0.1", "port": 8765, "prefix": "/app", "ws": false }
```
访问 `http://127.0.0.1:2536/zy` → 转发到 `http://127.0.0.1:8765/app`。

**2) 前端用到的绝对路径资源(SPA 常见):**
```json
{ "enable": true, "name": "GsCore资源", "matchPath": "/app", "matchReferer": "", "host": "127.0.0.1", "port": 8765, "prefix": "/app", "ws": false }
```
页面内请求 `/app/...` → 转发到 `http://127.0.0.1:8765/app/...`。

**3) 接口 `/api`(可能被多个服务共用 → 按来源分流):**
```json
{ "enable": true, "name": "GsCore API", "matchPath": "/api", "matchReferer": "/zy|/app", "host": "127.0.0.1", "port": 8765, "prefix": "/api", "ws": false }
```
`Referer` 含 `/zy` 或 `/app` 的 `/api` 请求 → 转发到 `http://127.0.0.1:8765/api`。

> **为什么 `/zy` 需要多条?** GsCore 面板页面往往用**绝对路径**(`/app`、`/api`)。访问 `/zy` 拿到页面后,页面会再去请求 `/app/...`、`/api/...`,浏览器不会自动拼到 `/zy` 后面,所以要分别为这些绝对路径建路由。这是这类前端反向代理的通用解法。

---

## 🔧 新增一个服务(以青龙 5700 为例)

### ⚠️ 先看:子路径面板必须设置「基础路径」

青龙这类 umi/react 打包的面板,前端资源与路由默认按**根路径**走。直接挂在 `/qinglong` 下会白屏,浏览器控制台报:

```
Refused to apply style from '.../login/umi.xxx.css' because its MIME type ('text/html') ...
Refused to execute script from '.../login/umi.xxx.js' because its MIME type ('text/html') ...
```

**原因**:面板要命中"我部署在 `/qinglong/` 下"这件事,得靠它自己的基础路径配置。没配的话,资源/接口路径会脱离前缀,后端找不到就返回 SPA 兜底 HTML(text/html),MIME 校验拒绝执行。

**解法(两步)**:

**第 1 步:让面板知道自己的基础路径。** 青龙提供了官方环境变量 **`QlBaseUrl`**:

```bash
# Docker
docker run -dit ... -e QlBaseUrl="/qinglong/" -e QlPort="5700" whyour/qinglong
# docker-compose.yml
environment:
  - QlBaseUrl=/qinglong/
# 非 Docker / 面具模块:在启动脚本的 env 里加 QlBaseUrl=/qinglong/(注意 pm2 会缓存旧环境,改后要连 pm2 一起重启)
```

> 规则:`QlBaseUrl` 必须**以 `/` 开头和结尾**,且要和你挂载的路径一致(挂 `/qinglong` 就填 `/qinglong/`)。

**第 2 步:插件用「剥离前缀」转发**(`prefix` 填 `/`)。

这里有个**关键点**:青龙的 `QlBaseUrl` 只影响**前端运行时**(它用 `/qinglong/` 作为 API 与路由的 base),而**后端的静态资源和接口实体仍在根目录**(`/umi.xxx.js`、`/api/env.js`)。所以代理**必须把 `/qinglong` 前缀剥掉**,转发到后端根:

```json
{ "enable": true, "name": "青龙面板", "matchPath": "/qinglong", "matchReferer": "", "host": "127.0.0.1", "port": 5700, "prefix": "/", "ws": false }
```

- `matchPath=/qinglong` + `prefix=/` = **剥掉 `/qinglong` 转发到后端根目录**:
  `/qinglong/umi.xxx.js` → `:5700/umi.xxx.js`、`/qinglong/api/env.js` → `:5700/api/env.js`、`/qinglong/api/...` → `:5700/api/...`、`/qinglong/login` → `:5700/login`。
- 浏览器始终停在 `/qinglong/...` 下(QlBaseUrl 让前端路由与接口都带这个前缀),插件再剥掉转发,两边就对齐了。
- **一处不对齐的典型症状**:若 `prefix` 误填 `/qinglong`(原样透传),`/qinglong/api/env.js` 在后端不存在 → 返回 HTML → 前端拿不到 QlBaseUrl → 又跳回根路径 `/login` 白屏。**务必用 `prefix=/`。**

> 常见误区:以为"设了 QlBaseUrl 就该透传"。实际上 QlBaseUrl 只改前端,后端仍在根;**剥离**才是正解。

### 对不支持的子路径的面板怎么办?

极少数面板**没有**基础路径配置项,此时用子路径代理基本无解(前端写死了根路径)。可选方案:

1. **改用子域名**:如 `ql.example.com` 反代到 `127.0.0.1:5700`,面板用根路径正常。
2. 用能改写响应体的代理(Nginx `sub_filter` 等)把绝对路径重写掉 —— 较脆弱,不推荐。

---

## 🔀 进阶:`matchPath` 与 `prefix` 的区别

`prefix` 决定转发到后端的路径怎么拼。记住公式:**转发路径 = `prefix` + (请求去掉 `matchPath` 后的剩余路径)**。

| matchPath | prefix | 访问 | 转发到后端 | 适用 |
|-----------|--------|------|-----------|------|
| `/memes` | `/memes` | `/memes/a.png` | `/memes/a.png` | 原样透传(后端本身带该前缀) |
| `/zy` | `/app` | `/zy/x` | `/app/x` | 换前缀(别名) |
| `/qinglong` | `/` | `/qinglong/login` | `/login` | **剥离前缀**到后端根(配合 `QlBaseUrl` 的面板) |
| `/ncqq` | `/` | `/ncqq/abc` | `/abc` | 剥离前缀(后端在根目录) |


---

## 🩺 状态页 `/__web-mount__`

在 Yunzai 的 HTTP 端口上访问:

```
http://127.0.0.1:2536/__web-mount__          # HTML 页面
http://127.0.0.1:2536/__web-mount__?format=json   # JSON(便于脚本/监控)
```

页面内容:

| 区块 | 说明 |
|------|------|
| 概览卡片 | 路由总数、后端在线数、累计请求、累计错误、当前超时 |
| 路由表格 | 名称、匹配路径/来源/方法、目标地址、是否 WS、请求数、错误数、最近状态码、耗时、最近访问时间 |
| 在线指示灯 | 绿=后端端口可连通,红=连不上(每次打开页面实时探测,800ms 超时) |

- 设了 `statusToken` 后需要 `?token=你的口令`,未带 token 返回 401。
- 想关掉整页:把「状态页」开关关掉(`statusPage: false`)。状态页优先于所有路由,不会被用户的规则抢走。

---

## 📁 配置与 Git

插件配置目录:`plugins/web-mount/config/`

| 文件 | 说明 | Git |
|------|------|-----|
| `config.json` | **真实运行配置**(含各服务端口/路径等本机信息) | ✅ 已 `.gitignore` 忽略 |
| `default_config.json` | 默认模板,首次运行缺 `config.json` 时自动复制 | 📌 提交到仓库 |

首次克隆若没有 `config.json`,插件会自动从 `default_config.json` 复制。若你的 `config.json` 已被 git 跟踪过,执行一次:

```bash
git rm --cached plugins/web-mount/config/config.json
git commit -m "stop tracking local config"
```

---

## 🩺 常见问题(FAQ)

**Q: 面板挂到子路径后白屏,控制台报 MIME type ('text/html') 不是样式表/脚本?**
A: 面板前端默认按**根路径**取资源(`/umi.xxx.js`、`/api/...`),挂到 `/qinglong` 下就不匹配了。**两步**:①给面板设基础路径 —— 青龙用 `QlBaseUrl=/qinglong/`(让前端路由与接口都带该前缀);②插件这条路由用 **`prefix=/` 剥离前缀**,转发到后端根目录。详见「新增一个服务」一节。

**Q: 访问 `/qinglong` 提示登录失效,跳转 `/login` 后跳到仓库页(如 gitee/Yunzai)/ 白屏?**
A: 说明面板没做子路径适配(或插件前缀配错)。正解:①青龙设 `QlBaseUrl=/qinglong/`;②插件路由 `matchPath=/qinglong` + **`prefix=/`**。改完后前端跳转会变成 `/qinglong/login`,经插件剥离后到 `:5700/login`。**注意**:若 `prefix` 误填成 `/qinglong`(透传),`/qinglong/api/env.js` 在后端不存在 → 前端拿不到 base → 又跳回 `/login` 白屏。

**Q: `/api` 是多个服务共用的,会互相抢吗?**
A: 会。给 `/api` 建多条规则,每条用 `matchReferer` 限定来源;顺序即优先级,默认兜底规则放最后。若都不匹配会放行给 Yunzai(可再配一条来源留空的 `/api` 兜底)。

**Q: 访问某个路径返回 `502 Bad Gateway`?**
A: 插件连不上目标后端。①打开 `/__web-mount__` 看该路由的指示灯是不是红的;②确认后端端口确实在监听(`ss -tlnp | grep 端口`);③若后端是容器/其他设备,`host` 不能填 `127.0.0.1`。错误信息会带路由名和实际转发的路径,控制台也有一条 `转发失败 ...` 日志(同一路由 10 秒内只记一条)。

**Q: 保存配置后没生效?**
A: 默认 2 秒自动热重载,稍等一下刷新页面即可;若关掉了「配置热重载」,需要重启 Yunzai。注意热重载监听的是 `plugins/web-mount/config/config.json` 的修改时间。

**Q: 我配了 `matchPath: "/"` 兜底,结果 Yunzai 自己的页面全被代理走了?**
A: `/` 会匹配所有路径,包括 Yunzai 自身的路由。**不要轻易用 `/` 兜底**;如果确实需要,请把更具体的路径都配上(最长路径优先,不会被 `/` 抢走),并清楚它会接管所有未匹配请求。

**Q: WebSocket 支持吗?**
A: 支持。需要 WS 的路由把 `ws` 设为 `true`(如 NapCat 实时日志 `/ws`);连接关闭时会同时清理两端。

**Q: POST/PUT 到后端的请求体是空的?**
A: 旧版本存在这个问题(Yunzai 的 body-parser 已经把请求流读完,再 `pipe` 只会拿到空流)。当前版本会判断 `req._body` / `readableEnded`,已解析的请求用 `req.body` 重新序列化后转发,不会再丢。

---

## 📄 许可证

[MIT](LICENSE) — 自由使用、修改与分发。

## 🙏 致谢

- [Yunzai-Bot v3](https://github.com/TimeRainStarSky/Yunzai)
- 锅巴面板(guoba)社区
