# web-mount 端口挂载插件(Yunzai v3)

把本机各端口上的服务(如 meme 站、GsCore 面板、NapCat WebUI、青龙面板等)
反向代理挂载到 **Yunzai HTTP 端口**(你的 `127.0.0.1:2536`)的任意路径下,
并通过锅巴面板可视化配置。支持普通 HTTP 与 WebSocket(WS)转发。

---

## 一、它到底在做什么

- **路由(route)**:一行 = 一条转发规则
  `匹配路径(matchPath) [+ 来源(matchReferer)] -> 目标主机:端口/目标内前缀`
  。请求按规则**自上而下匹配,命中第一条即转发**。
- 同一个 `matchPath` 可以出现多条,靠「来源(Referer/Origin)」区分——
  这正是解决 `GsCore / NapCat / 青龙 都叫 /api` 的关键:按来源把 `/api` 分到不同后端。
- 同理,`/login` 也可按来源分发(青龙登录页就是 `/login`)。
- WebSocket:用 `Bot.server` 监听 `upgrade` 事件,把 WS(如 NapCat 实时日志)也代理过去。

> 核心依赖:Yunzai 的 `Bot.express`(HTTP 中间件)与 `Bot.server`(底层 HTTP 服务)。
> 所以插件挂在 **Yunzai HTTP 端口**下 —— 你的场景就是 `127.0.0.1:2536`。

---

## 二、最终效果

```
                    ┌────────────────────────────────────────────┐
                    │         Yunzai HTTP 服务 (127.0.0.1:2536)  │
                    │                                            │
  /guoba     ────────► 锅巴面板本身(Yunzai 自带的插件页面)       │
  /memes     ────────► :3132/memes          (meme 预览站)        │
  /zy        ────────► :8765/app            (GsCore 面板入口)     │
  /app       ────────► :8765/app            (GsCore 绝对路径资源)  │
  /webui     ────────► :6099/webui          (NapCat WebUI)       │
  /ws        ────────► :6099/ws             (NapCat WebSocket)   │
  /files     ────────► :6099/files          (NapCat 主题文件)    │
  /ncqq      ────────► :6099                (NapCat 入口)        │
  /qinglong  ────────► :5700                (青龙面板)            │
  /login     ────────► :5700/login          (青龙登录页,按来源)   │
                    │                                            │
  /api/... ──按来源分发──►                                      │
     referer=/zy|/app     → :8765/api (GsCore)                  │
     referer=/webui|/ncqq → :6099/api (NapCat)                  │
     referer=/qinglong|/login → :5700/api (青龙)                │
                    └────────────────────────────────────────────┘
```

浏览器里打开 `http://127.0.0.1:2536/zy`、`/webui`、`/qinglong` …… 即可,不用记一堆端口。

---

## 三、为什么 /api、/login 需要「多条规则」

很多前端页面写的是**绝对路径**。例如打开 `/zy` 拿到页面后,页面内部会去请求 `/app/...`、`/api/...`;
青龙登录失败会**重定向到 `/login`**。这些绝对路径浏览器不会自动拼到 `/zy`、`/qinglong` 后面,
所以你要为它们单独建路由。当多个服务共用一条绝对路径(如 `/api`)时,
就用「来源 matchReferer」区分发到哪个后端。

`config.json` 里就是这种模型,一目了然:
```json
{ "enable": true, "name": "青龙面板", "matchPath": "/qinglong", "matchReferer": "",   "host": "127.0.0.1", "port": 5700, "prefix": "/",      "ws": false },
{ "enable": true, "name": "青龙登录", "matchPath": "/login",   "matchReferer": "/qinglong|/login", "host": "127.0.0.1", "port": 5700, "prefix": "/login", "ws": false },
{ "enable": true, "name": "青龙 API", "matchPath": "/api",     "matchReferer": "/qinglong|/login", "host": "127.0.0.1", "port": 5700, "prefix": "/api",   "ws": false }
```
> 关键:青龙登录页(`/login`)发起的登录接口也是 `/api`,所以「青龙 API」的**来源同时配了 `/qinglong|/login`**,
> 否则登录时接口会因为 Referer 是 `/login` 而配不上、直接 404。已默认配好。

---

## 四、新增一个服务(以青龙 5700 为例)

在锅巴面板 → 端口挂载 → 路由列表,新增:一条「面板入口」+ 需要的「绝对路径」路由:

| 名称 | matchPath | matchReferer | 目标端口 | 目标内前缀 |
|------|-----------|--------------|----------|-----------|
| 青龙面板 | `/qinglong` | (留空) | `5700` | `/` |
| 青龙登录 | `/login` | `/qinglong\|/login` | `5700` | `/login` |
| 青龙 API | `/api` | `/qinglong\|/login` | `5700` | `/api` |

保存后**重启 Yunzai 生效**。

> **匹配规则**:`matchPath` 与 `matchReferer` 同时满足才命中(必填 path,来源可留空=不限)。
> **匹配顺序**:自上而下,命中第一条即转发;**更重要/更精确的规则放前面**。
> **来源多关键字**:用 `|` 分隔,如 `/zy|/app`。

---

## 五、字段说明

| 字段 | 说明 |
|------|------|
| enable | 是否启用 |
| name | 名称,便于辨认与日志 |
| matchPath | 浏览器请求的 URL 路径前缀(如 `/api`、`/login`、`/memes`) |
| matchReferer | 来源(Referer/Origin)包含此字符串才命中,`\|` 分隔多个,留空=不限 |
| host / port | 目标主机 / 端口 |
| prefix | 目标内前缀(服务内部的根路径,如 `/app`、`/login`) |
| ws | 该服务是否需要 WebSocket 转发 |

> `prefix` 与 `matchPath` 共同决定转发路径:目标实际路径 = `prefix` + 命中后的剩余路径。

---

## 六、安装与 Git 忽略(上传 GitHub 不泄露本地配置)

1. 把 `web-mount` 文件夹放到 `Yunzai/plugins/`:
   `Yunzai/plugins/web-mount/`
2. 启动 Yunzai 即生效;去锅巴面板可改配置。
3. **关于 git**:
   - 你的**真实运行配置**在 `config/config.json`(含各服务端口/路径等本机信息)。
   - 插件包内置了 `.gitignore`,**已忽略 `config/config.json`**,不会提交到 git。
   - 仓库里提交的是**默认模板** `config/config.json` 的副本 —— 即 `config/default_config.json`。
   - 若你的 `config/config.json` 之前已被 git 跟踪过,需执行一次:
     `git rm --cached plugins/web-mount/config/config.json` 再提交。
   - 首次克隆后若没有 `config/config.json`,插件会自动从 `config/default_config.json` 复制。

---

## 七、本次修复 / 优化点

- **修复 WS 转发 bug**:原代码 `pQes.headers[k]` 拼写错误导致 WebSocket 转发异常,已改为 `pRes.headers[k]`。
- **统一路由模型 `routes[]`**:取代原先拆开的 `mounts + dispatch`。同一路径(`/api`、`/login`)可建多条规则按来源区分,
  从根上解决「/api 只能分两个后端」「锅巴面板加不了第三个服务」「青龙 /login 跳转没转发」等问题。
- **青龙登录修复**:新增 `/login` 路由指向 `:5700/login`,并把青龙 `/api` 来源扩为 `/qinglong|/login`,登录接口不再 404。
- **启动全量日志**:启动时**逐条打印实际挂载的路由**,最后给出汇总条数与路径列表;单条配置无效(端口/路径缺失)会单独记 warning 并跳过,而不是静默吞掉后续。
- **旧格式自动迁移**:原先的 `mounts + dispatch{match/defaultHost/altPort}` 会自动转成 `routes[]`,升级不丢配置。
- **标准反向代理头**:自动注入 `X-Forwarded-For / Host / Proto`。
- **无匹配放行**:没有规则命中的请求 `next()` 放行,不影响 Yunzai 自身路由。
- **默认配置模板 + 自动补全**:`config/default_config.json` 作为 git 模板,缺 `config.json` 时自动复制。
