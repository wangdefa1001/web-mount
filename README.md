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

- **统一路由模型 `routes[]`**:一行一条规则,顺序匹配、首条命中。简单挂载、按来源分发(智能分发)都在同一张表里,没有两套规则难理解的旧设计。
- **按来源分流**:不同服务共用同一条绝对路径(最常见是 `/api`)也不打架 —— 用 `matchReferer` 按请求来源(Referer/Origin)分到不同后端。
- **支持 WebSocket**:NapCat 实时日志、WebSocket 面板等可用 `ws: true` 开启。
- **统一处理绝对路径**:SPA 页面内的 `/app`、`/login` 等绝对路径都可以单独建路由。
- **增强转发头**:自动注入 `X-Forwarded-For / Host / Proto`。
- **启动全量日志**:启动时逐条 + 汇总打印本插件的所有路由;单条无效配置只警告跳过,不中断。
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

打开锅巴面板 → **端口挂载**,在「路由列表」里增删即可;保存后**重启 Yunzai 生效**。

每条规则字段:

| 字段 | 说明 |
|------|------|
| `enable` | 是否启用 |
| `name` | 名称,便于辨认与日志 |
| `matchPath` | 浏览器访问的 URL 路径前缀,如 `/api`、`/login`、`/memes` |
| `matchReferer` | 请求来源(Referer/Origin)包含此字符串才命中,`\|` 分隔多个;留空=不限制 |
| `host` / `port` | 目标主机 / 端口 |
| `prefix` | 目标内前缀(服务根路径,如 `/app`、`/login`) |
| `ws` | 该服务是否需要 WebSocket 转发 |

> **命中规则**:`matchPath` 与 `matchReferer` 同时满足才命中(`matchPath` 必填,`matchReferer` 可留空)。
> **顺序很重要**:自上而下匹配,**命中第一条即转发**;更精确/更重要的规则放前面。
> **同一路径多条**:如 `/api` 建多条并按 `matchReferer` 区分,顺序即优先级。

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

面板里加 3 条(入口 + 登录页 + 接口),**青龙登录页 `/login` 和它的 `/api` 接口都不要限制来源**(Referer 可能为空):

```json
{ "enable": true, "name": "青龙面板", "matchPath": "/qinglong", "matchReferer": "", "host": "127.0.0.1", "port": 5700, "prefix": "/",      "ws": false },
{ "enable": true, "name": "青龙登录", "matchPath": "/login",   "matchReferer": "", "host": "127.0.0.1", "port": 5700, "prefix": "/login", "ws": false },
{ "enable": true, "name": "青龙 API", "matchPath": "/api",     "matchReferer": "", "host": "127.0.0.1", "port": 5700, "prefix": "/api",   "ws": false }
```

> ⚠️ 若其它服务也用 `/api`,**不要**把青龙 `/api` 的 `matchReferer` 留空,否则会把所有人的 `/api` 都抢走。此时应保留来源限制,并把多个来源用 `|` 合并,如 `/qinglong|/login`。

---


## 📄 许可证

[MIT](LICENSE) — 自由使用、修改与分发。


