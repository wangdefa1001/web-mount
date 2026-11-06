/**
 * 内置状态页：鉴权、登录、配置读写接口、页面渲染。
 *
 * 与业务无关，只依赖 lib/status.js 的运行数据与 lib/config.js 的读写函数。
 * 需要重载路由时通过构造参数注入回调，避免这里反向 import 插件主类（会形成循环依赖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { state, collectStatus, resetStats } from './status.js'
import { readEditorData, saveFromEditor } from './config.js'

export const STATUS_PATH = '/__web-mount__'

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 定长比较，避免按字符逐位比较泄露信息
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// 状态页自身的路径判断（含子路径），供中间件第一道分流使用
export function isStatusPath(pathname) {
  return pathname === STATUS_PATH || pathname === STATUS_PATH + '/' || pathname.startsWith(STATUS_PATH + '/')
}

export class StatusPage {
  /**
   * @param {object} opts
   * @param {string} opts.pluginDir 插件目录（读 guoba/dashboard.*）
   * @param {() => void} opts.reload 重载配置（保存后立刻生效）
   */
  constructor({ pluginDir, reload }) {
    this.pluginDir = pluginDir
    this.reload = reload
  }

  authCookieValue(token) {
    return crypto
      .createHash('sha256')
      .update('web-mount::' + token)
      .digest('hex')
  }

  checkAuth(req) {
    const token = state.settings.statusToken
    if (!token) return true
    const cookie = req.headers.cookie || ''
    const m = cookie.match(/(?:^|;\s*)wm_auth=([^;]+)/)
    if (m && m[1] === this.authCookieValue(token)) return true
    const h = req.headers['x-wm-token']
    if (typeof h === 'string' && h && h === token) return true
    return false
  }

  sendJson(res, code, obj) {
    const body = JSON.stringify(obj, null, 2)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  // 读取表单 body。
  // 注意：不能只靠 req._body 判断 —— 部分 Yunzai/express 版本只把解析结果放进 req.body，
  // 并不设置 _body，此时若按「未解析」去读流，流早已读完，会拿到空字符串（表现为“口令不正确”）。
  // 策略：req.body 有实际内容就用它，否则再尝试读流。
  readFormBody(req) {
    return new Promise(resolve => {
      const body = req.body
      if (body != null) {
        if (typeof body === 'string') {
          if (body) return resolve(body)
        } else if (Buffer.isBuffer(body)) {
          if (body.length) return resolve(body.toString('utf8'))
        } else if (typeof body === 'object') {
          const keys = Object.keys(body)
          if (keys.length) {
            const p = new URLSearchParams()
            for (const k of keys) p.set(k, String(body[k]))
            return resolve(p.toString())
          }
        }
      }
      if (req.readableEnded) return resolve('')
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size <= 65536) chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  // 读取 JSON 请求体（配置区保存用）
  readJsonBody(req) {
    return new Promise(resolve => {
      const body = req.body
      if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return resolve(body)
      if (typeof body === 'string' && body) {
        try {
          return resolve(JSON.parse(body))
        } catch {
          return resolve(null)
        }
      }
      if (req.readableEnded) return resolve(null)
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size <= 1048576) chunks.push(c)
      })
      req.on('end', () => {
        try {
          const txt = Buffer.concat(chunks).toString('utf8')
          resolve(txt ? JSON.parse(txt) : null)
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  async handle(req, res, url, pathname) {
    const cfg = state.settings
    const sub = pathname.slice(STATUS_PATH.length).replace(/\/+$/, '')
    const authed = this.checkAuth(req)

    if (sub === '/logout') {
      res.writeHead(302, {
        'set-cookie': 'wm_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        location: STATUS_PATH,
      })
      return res.end()
    }

    if (!authed) {
      if (sub === '/reload' || sub === '/reset' || sub === '/config')
        return this.sendJson(res, 401, { ok: false, message: '未授权' })
      if (/[?&]format=json\b/.test(url)) return this.sendJson(res, 401, { ok: false, message: '未授权' })
      if (req.method === 'POST' && sub === '') return this.handleLogin(req, res)
      return this.renderLogin(res, '')
    }

    if (sub === '/reload') {
      try {
        this.reload()
        return this.sendJson(res, 200, {
          ok: true,
          message: `已重载，生效 ${state.routes.length} 条`,
          routes: state.routes.length,
        })
      } catch (e) {
        return this.sendJson(res, 500, { ok: false, message: e.message })
      }
    }

    if (sub === '/reset') {
      resetStats()
      return this.sendJson(res, 200, { ok: true, message: '统计已清空' })
    }

    // 配置区：读 / 写 config.json
    if (sub === '/config') {
      if (!cfg.configEditor) {
        return this.sendJson(res, 403, { ok: false, message: '配置编辑已在设置中关闭' })
      }
      if (req.method === 'GET') {
        return this.sendJson(res, 200, { ok: true, result: readEditorData(this.pluginDir, logger) })
      }
      if (req.method === 'POST') {
        // 未设口令时状态页本身就是公开的，不能让任何人改配置
        if (!cfg.statusToken) {
          return this.sendJson(res, 403, {
            ok: false,
            message: '未设置访问口令，配置功能已禁用。请先在锅巴面板设置口令，或在面板内直接编辑。',
          })
        }
        const body = await this.readJsonBody(req)
        if (!body) return this.sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
        try {
          saveFromEditor(this.pluginDir, body, logger)
          this.reload()
          return this.sendJson(res, 200, { ok: true, message: `已保存并生效，共 ${state.routes.length} 条路由` })
        } catch (e) {
          return this.sendJson(res, 500, { ok: false, message: '保存失败：' + e.message })
        }
      }
      return this.sendJson(res, 405, { ok: false, message: '不支持的请求方法' })
    }

    if (sub) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }

    const data = await collectStatus()
    if (/[?&]format=json\b/.test(url)) return this.sendJson(res, 200, data)
    return this.renderStatusPage(res, data)
  }

  async handleLogin(req, res) {
    const ip = req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    const rec = state.loginFails.get(ip) || { n: 0, until: 0 }

    if (rec.until > now) {
      return this.renderLogin(res, `尝试次数过多，请 ${Math.ceil((rec.until - now) / 1000)} 秒后重试`, 429)
    }

    const raw = await this.readFormBody(req)
    let token = ''
    try {
      token = new URLSearchParams(raw).get('token') || ''
    } catch {
      /* ignore */
    }

    const expected = state.settings.statusToken

    if (state.settings.debug) {
      logger.mark(
        `[web-mount] 状态页登录：body ${raw.length} 字节，取到 ${token.length} 字符，`
          + `期望 ${expected.length} 字符，${token && safeEqual(token, expected) ? '匹配' : '不匹配'}`,
      )
    }

    if (token && safeEqual(token, expected)) {
      state.loginFails.delete(ip)
      res.writeHead(302, {
        'set-cookie': `wm_auth=${this.authCookieValue(expected)}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`,
        location: STATUS_PATH,
      })
      return res.end()
    }

    // 没取到 token：多半是请求体没读到（不是口令错），单独提示，且不计入失败次数
    if (!token) {
      return this.renderLogin(res, '没有收到口令，请重新输入', 400)
    }

    rec.n++
    if (rec.n >= 5) {
      rec.until = now + 60000
      rec.n = 0
    }
    state.loginFails.set(ip, rec)
    return this.renderLogin(res, '口令不正确，请重试', 401)
  }

  /* ---- 登录页 ---- */
  renderLogin(res, error, code) {
    const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>web-mount · 验证</title>
<style>
  :root{
    --bg:#f5f7fa; --card:#ffffff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb;
    --accent:#3b82f6; --accent2:#8b5cf6; --bad:#ef4444;
    --shadow:0 10px 40px -12px rgba(17,24,39,.18);
  }
  @media (prefers-color-scheme: dark){
    :root{--bg:#0b0e14; --card:#141922; --fg:#e6edf3; --muted:#94a3b8; --line:#232b38;
          --accent:#60a5fa; --accent2:#a78bfa; --bad:#f87171;
          --shadow:0 10px 40px -12px rgba(0,0,0,.7);}
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;display:grid;place-items:center;padding:24px;
    background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background-image:radial-gradient(900px 400px at 50% -10%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%);
  }
  .box{
    width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);
    border-radius:18px;padding:32px 28px;box-shadow:var(--shadow);
  }
  .logo{
    width:46px;height:46px;border-radius:14px;display:grid;place-items:center;
    background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
    font-size:22px;margin-bottom:18px;box-shadow:0 6px 18px -6px var(--accent);
  }
  h1{margin:0 0 6px;font-size:19px;letter-spacing:.2px}
  p.sub{margin:0 0 22px;color:var(--muted);font-size:13px}
  label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:7px;font-weight:600}
  input[type=password],input[type=text]{
    width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);
    background:color-mix(in srgb, var(--bg) 55%, var(--card));color:var(--fg);
    font-size:15px;outline:none;transition:.18s;letter-spacing:.3px;
  }
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)}
  button{
    width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;cursor:pointer;
    background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
    font-size:15px;font-weight:600;letter-spacing:.3px;transition:.18s;
  }
  button:hover{filter:brightness(1.06)}
  button:active{transform:translateY(1px)}
  .err{
    margin-top:14px;padding:9px 12px;border-radius:9px;font-size:13px;
    background:color-mix(in srgb, var(--bad) 12%, transparent);
    color:var(--bad);border:1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  }
  .foot{margin-top:18px;text-align:center;color:var(--muted);font-size:12px}
</style></head>
<body>
<form class="box" method="POST" action="${STATUS_PATH}">
  <div class="logo">◈</div>
  <h1>web-mount 状态面板</h1>
  <p class="sub">该面板已设置访问口令，请输入后继续</p>
  <label for="token">访问口令</label>
  <input id="token" name="token" type="password" placeholder="请输入口令" autocomplete="current-password" autofocus required>
  <button type="submit">进入面板</button>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <div class="foot">口令可在锅巴面板 → 端口挂载 → 「状态页口令」里修改</div>
</form>
</body></html>`

    res.writeHead(code || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  /* ---- 仪表盘 ---- */
  // 状态页与锅巴扩展页面共用 guoba/ 下的 html/css/js，避免维护两套界面。
  // 独立页把 css/js 内联进来（自包含），锅巴页则由锅巴的静态资源服务提供。
  renderStatusPage(res, data) {
    try {
      const guobaDir = path.join(this.pluginDir, 'guoba')
      let html = fs.readFileSync(path.join(guobaDir, 'dashboard.html'), 'utf8')
      const css = fs.readFileSync(path.join(guobaDir, 'dashboard.css'), 'utf8')
      const js = fs.readFileSync(path.join(guobaDir, 'dashboard.js'), 'utf8')

      const payload = JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')

      html = html
        .replace('<link rel="stylesheet" href="dashboard.css">', '<style>\n' + css + '\n</style>')
        .replace(
          '<script src="dashboard.js"></script>',
          '<script>window.__WM__='
            + payload
            + ';window.__WM_PATH__='
            + JSON.stringify(STATUS_PATH)
            + ';</script>\n<script>\n'
            + js
            + '\n</script>',
        )

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    } catch (e) {
      logger.error('[web-mount] 渲染状态页失败: ' + e.message)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('状态页资源缺失（guoba/dashboard.html|css|js），请确认插件文件完整')
    }
  }
}
