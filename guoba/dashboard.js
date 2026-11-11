(function () {
  'use strict';

  // 两种运行环境：
  //   1) 锅巴面板扩展页面(iframe)：地址上带 __apiBase / token，走锅巴接口，自带登录鉴权
  //   2) 独立状态页：同源请求 /__web-mount__，靠 Cookie 鉴权
  var Q = new URLSearchParams(location.search);
  var API_BASE = Q.get('__apiBase') || '';
  var TOKEN = Q.get('token') || '';
  var IS_GUOBA = !!API_BASE;
  var PATH = window.__WM_PATH__ || '/__web-mount__';

  // 站点根路径（Yunzai 若部署在子路径下，这里会带上）
  var BASE = (function () {
    if (!IS_GUOBA) {
      var p = location.pathname;
      return (p.length > PATH.length && p.lastIndexOf(PATH) === p.length - PATH.length)
        ? p.slice(0, p.length - PATH.length) : '';
    }
    var wb = Q.get('__webBase') || '';
    if (wb && wb !== '/') {
      var i = wb.lastIndexOf('/');
      return i > 0 ? wb.slice(0, i) : '';
    }
    return '';
  })();

  var S = window.__WM__ || { routes: [], totals: {}, traffic: [], settings: {}, services: [] };
  var sortKey = '', sortDir = 1, kw = '', timer = null;

  // 配置抽屉的状态：打开时的原始快照，用来判断「有没有未保存的改动」
  var cfgSnap = '';
  var cfgTab = 'routes';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function time(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* 相对时间：状态页每 3 秒刷新，绝对时间戳（10-11 03:12:45）每次都要重新读一遍；
     「12 秒前」一眼就知道是不是刚发生过的事。超过一天才退回绝对时间。 */
  function ago(ts) {
    if (!ts) return '—';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return time(ts);
  }
  function dur(ms) {
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }
  function uptime(ms) {
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s %= 86400;
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    if (d) return d + '天' + h + '小时';
    if (h) return h + '小时' + m + '分';
    if (m) return m + '分' + s + '秒';
    return s + '秒';
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', kind === 'err');
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, kind === 'err' ? 3600 : 2400);
  }

  /* ================================================================== *
   * 确认条：替代原生 confirm()
   *
   * 原生 confirm 会阻塞整个 JS 线程 —— 自动刷新、Toast 全部卡住，而且
   * 样式无法控制、在 iframe 里体验更差。这里用页面内浮层实现，返回 Promise。
   * ================================================================== */
  var cfResolve = null;
  function confirmBox(text) {
    var box = $('confirm');
    if (!box) return Promise.resolve(true);
    box.querySelector('.cf-t').textContent = text;
    box.hidden = false;
    return new Promise(function (resolve) { cfResolve = resolve; });
  }
  function settleConfirm(ok) {
    var box = $('confirm');
    if (box) box.hidden = true;
    if (cfResolve) {
      var r = cfResolve;
      cfResolve = null;
      r(ok);
    }
  }

  /* ---------- 嵌入面板时的适配 ---------- */
  function applyEmbed() {
    document.body.classList.add('embed');
    try {
      var pd = window.parent.document;
      var bg = getComputedStyle(pd.body).backgroundColor || '';
      var m = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
      if (!m) return;
      var alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (alpha <= 0.05) return;
      var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      document.documentElement.classList.toggle('force-dark', lum < 0.5);
    } catch (e) { /* 跨域，忽略 */ }
  }

  if (IS_GUOBA) {
    applyEmbed();
    try {
      new MutationObserver(applyEmbed).observe(window.parent.document.documentElement, {
        attributes: true, attributeFilter: ['class', 'data-theme', 'style'],
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- 数据通道 ---------- */
  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) {
        var e = new Error(String(r.status));
        e.status = r.status;
        throw e;
      }
      return r.json();
    });
  }

  function apiUrl(sub) {
    return IS_GUOBA ? API_BASE + sub : PATH + sub;
  }

  function reqOpts(extra) {
    var o = extra || {};
    o.headers = o.headers || {};
    if (IS_GUOBA) o.headers['guoba-access-token'] = TOKEN;
    else o.credentials = 'same-origin';
    return o;
  }

  function apiGet(sub) {
    return fetchJson(apiUrl(sub), reqOpts()).then(function (d) {
      return (d && d.result !== undefined) ? d.result : d;
    });
  }

  function apiSend(sub, body) {
    var o = reqOpts({ method: 'POST', headers: {} });
    if (body !== undefined) {
      o.headers['content-type'] = 'application/json';
      o.body = JSON.stringify(body);
    }
    return fetchJson(apiUrl(sub), o).then(function (d) {
      return { ok: d.ok !== false, message: d.message || '完成', result: d.result };
    });
  }

  function fetchStatus() {
    if (IS_GUOBA) return apiGet('/data');
    return fetchJson(PATH + '?format=json', { credentials: 'same-origin' });
  }

  /* ================================================================== *
   * 渲染
   * ================================================================== */

  /* 概览卡片。顺序按"想先看到什么"排：能不能用(在线) > 有多少路(路由) >
     跑了多少(请求) > 有没有问题(错误) > 快不快(耗时)。 */
  function renderCards(t) {
    var offline = (t.routes || 0) - (t.online || 0);
    var items = [
      {
        k: '在线后端',
        v: num(t.online),
        cls: offline ? 'bad' : (t.online ? 'ok' : ''),
        sub: '/' + num(t.routes),
        hint: offline ? offline + ' 个连不上' : '全部可达',
      },
      { k: '路由', v: num(t.routes), cls: '', sub: t.auto ? '含 ' + t.auto + ' 自动' : '' },
      { k: '累计请求', v: num(t.req), cls: '', sub: '' },
      { k: '累计错误', v: num(t.err), cls: t.err ? 'bad' : '', sub: t.req ? ((t.err / t.req) * 100).toFixed(1) + '%' : '' },
      { k: '平均耗时', v: t.avgMs ? dur(t.avgMs) : '—', cls: '', sub: '' },
    ];
    var h = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      h += '<div class="card" title="' + esc(it.hint || '') + '"><span>' + it.k + '</span>' +
        '<div class="v"><b class="' + it.cls + '">' + it.v + '</b>' +
        (it.sub ? '<em>' + esc(it.sub) + '</em>' : '') + '</div></div>';
    }
    $('cards').innerHTML = h;
  }

  function renderSites(list) {
    var el0 = $('sites');
    if (!el0) return;
    var panel = $('sites-panel');
    // 一条入口都没有时整块收起 —— 留个空盒子占地方，还天天提示同一句话，很烦
    if (!list || !list.length) {
      if (panel) panel.hidden = true;
      return;
    }
    if (panel) panel.hidden = false;
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var ch = (s.name || '?').trim().charAt(0).toUpperCase();
      h += '<button class="site" type="button" data-i="' + i + '" title="' + esc(BASE + s.path) + '">' +
        '<span class="ic">' + esc(ch) + '</span>' +
        '<span class="smeta"><span class="nm2">' + esc(s.name) + '</span>' +
        '<span class="pth">' + esc(s.path) + '</span></span>' +
        '<span class="dot ' + (s.online ? 'ok' : 'bad') + '" title="' + (s.online ? '在线' : '连不上') + '"></span>' +
        '</button>';
    }
    el0.innerHTML = h;
    var btns = el0.querySelectorAll('.site');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function () {
        var idx = Number(this.getAttribute('data-i'));
        var svc = (S.services || [])[idx];
        if (svc) openViewer(svc);
      });
    }
  }

  function renderSpark(tr) {
    var max = 1;
    for (var i = 0; i < tr.length; i++) if (tr[i] > max) max = tr[i];
    var now = Date.now();
    var h = '';
    for (var k = 0; k < tr.length; k++) {
      var v = tr[k];
      var pct = Math.max(2, Math.round(v / max * 100));
      var d = new Date(now - (tr.length - 1 - k) * 1000);
      var label = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      h += '<div class="bar" style="height:' + pct + '%" title="' + label + ' · ' + v + ' 次"' + (v ? '' : ' data-z="1"') + '></div>';
    }
    $('spark').innerHTML = h;
    var total = 0;
    for (var j = 0; j < tr.length; j++) total += tr[j];
    $('qps').textContent = '合计 ' + total + ' 次 / 峰值 ' + max + ' 次/秒';
  }

  function filtered() {
    var list = (S.routes || []).slice();
    if (kw) {
      var k = kw.toLowerCase();
      list = list.filter(function (r) {
        return (r.name + ' ' + r.matchPath + ' ' + r.matchReferer + ' ' + r.host + ':' + r.port + ' ' + r.prefix)
          .toLowerCase().indexOf(k) >= 0;
      });
    }
    if (sortKey) {
      list.sort(function (a, b) {
        var x = a[sortKey], y = b[sortKey];
        if (sortKey === 'target') { x = a.host + a.port; y = b.host + b.port; }
        if (typeof x === 'string' || typeof y === 'string') {
          x = String(x || ''); y = String(y || '');
          return x.localeCompare(y) * sortDir;
        }
        return ((x || 0) - (y || 0)) * sortDir;
      });
    }
    return list;
  }

  function renderRows() {
    var list = filtered();
    var all = (S.routes || []).length;
    $('cnt').textContent = list.length + (list.length !== all ? ' / ' + all : '');

    if (!list.length) {
      var msg, act = '';
      if (!all) {
        msg = '还没有任何挂载。添加一条路由，把本机某个端口的服务挂到这个地址下。';
        act = canEdit() ? '<div><button class="btn sm primary" id="empty-add">+ 添加第一条路由</button></div>' : '';
      } else {
        msg = '没有匹配「' + kw + '」的路由。';
      }
      $('rows').innerHTML = '<tr><td colspan="7" class="empty">' + esc(msg) + act + '</td></tr>';
      var ea = $('empty-add');
      if (ea) ea.addEventListener('click', function () { openDrawer('routes'); addRoute(); });
      return;
    }

    var h = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var tags = '';
      if (r.matchReferer) tags += '<span class="tag" title="来源需包含此串">来源 ' + esc(r.matchReferer) + '</span>';
      if (r.matchMethod) tags += '<span class="tag">' + esc(r.matchMethod) + '</span>';
      if (r.refererTokenHeader) tags += '<span class="tag" title="从来源页地址的 ?token= 补这个请求头">补 ' + esc(r.refererTokenHeader) + '</span>';
      if (r.ws) tags += '<span class="tag ws">WS</span>';
      if (r.auto) tags += '<span class="tag auto" title="由「自动 /api」派生，不写进 config.json">自动</span>';
      if (r.entry === true) tags += '<span class="tag entry">入口</span>';
      else if (r.entry === false && !r.auto) tags += '<span class="tag off">不进导航</span>';

      var stCls = r.lastStatus >= 400 ? 'st-err' : (r.lastStatus ? 'st-ok' : '');
      var target = esc(r.host) + ':' + esc(r.port) +
        (r.prefix && r.prefix !== '/' ? '<span style="opacity:.6">' + esc(r.prefix) + '</span>' : '');
      // 失败的路由整行标红一点，扫一眼就能定位问题行
      var rowCls = r.errors ? ' has-err' : '';

      h += '<tr class="' + rowCls.trim() + '">' +
        '<td class="lead"><div class="nm"><span class="dot ' + (r.online ? 'ok' : 'bad') + '" title="' +
          (r.online ? '在线 · ' + r.ping + 'ms' : '无法连接') + '"></span>' + esc(r.name) + '</div>' +
          '<div class="tags"><code>' + esc(r.matchPath) + '</code>' + tags + '</div></td>' +
        '<td data-l="目标"><code>' + target + '</code></td>' +
        '<td class="num" data-l="请求">' + num(r.count) + '</td>' +
        '<td class="num ' + (r.errors ? 'err-n' : '') + '" data-l="错误">' + (r.errors || '—') + '</td>' +
        '<td class="num ' + stCls + '" data-l="状态">' + (r.lastStatus || '—') + '</td>' +
        '<td class="num" data-l="耗时">' + dur(r.lastMs) + '</td>' +
        '<td class="num hide-sm" data-l="最近" style="opacity:.75" title="' + esc(time(r.lastAt)) + '">' + ago(r.lastAt) + '</td>' +
        '</tr>';
    }
    $('rows').innerHTML = h;
  }

  function renderMeta() {
    var st = S.settings || {};
    var t = S.totals || {};
    $('meta').textContent = (S.routes || []).length + ' 条路由' +
      (t.auto ? '（含 ' + t.auto + ' 条自动 /api）' : '') + ' · 运行 ' + uptime(S.uptime || 0);
    $('foot-info').innerHTML =
      '热重载 ' + (st.autoReload ? '<b style="color:var(--ok)">开启</b>' : '关闭') +
      ' · 调试日志 ' + (st.debug ? '开启' : '关闭') +
      ' · 超时 ' + (st.proxyTimeout || '-') + 'ms' +
      ' · ' + (IS_GUOBA ? '由锅巴鉴权' : '状态页' + (st.secured ? '已加口令' : '未设口令'));
  }

  function render(d) {
    S = d || { routes: [], totals: {}, traffic: [], settings: {}, services: [] };
    renderMeta();
    renderCards(S.totals || {});
    renderSites(S.services || []);
    renderSpark(S.traffic || []);
    renderRows();
    var btn = $('btn-config');
    // 不能编辑时把按钮藏掉，而不是留着点了才说"你没权限"
    if (btn) btn.hidden = !canEdit();
  }

  /* ---------- 拉取 ---------- */
  var pulling = false;
  function pull(manual) {
    if (pulling) return;                       // 自动刷新和手动刷新撞上时别叠请求
    pulling = true;
    if (manual) $('btn-refresh').classList.add('spin');
    fetchStatus().then(function (d) {
      render(d);
      if (manual) toast('已刷新');
    }).catch(function (e) {
      if (IS_GUOBA) {
        if (String(e.message) === '401') toast('锅巴登录已失效，请刷新面板', 'err');
        else toast('读取状态失败：' + e.message, 'err');
      } else if (String(e.message) === '401') {
        location.reload();
      } else if (manual) {
        toast('读取状态失败：' + e.message, 'err');
      }
    }).then(function () {
      pulling = false;
      if (manual) setTimeout(function () { $('btn-refresh').classList.remove('spin'); }, 400);
    });
  }

  function act(sub, okMsg) {
    apiSend(sub).then(function (d) {
      toast(d.message || okMsg);
      pull();
    }).catch(function (e) {
      toast('操作失败' + (e && e.message ? '（' + e.message + '）' : ''), 'err');
    });
  }

  /* ---------- 下拉菜单 ---------- */
  function closeMenu() {
    var m = $('menu');
    if (m && !m.hidden) {
      m.hidden = true;
      $('btn-more').setAttribute('aria-expanded', 'false');
    }
  }
  function toggleMenu() {
    var m = $('menu');
    var open = m.hidden;
    m.hidden = !open;
    $('btn-more').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ---------- 页面查看器 ---------- */
  function openViewer(svc) {
    var url = BASE + svc.path;
    $('viewer-title').textContent = svc.name;
    $('viewer-title').title = url;
    $('viewer-open').setAttribute('href', url);
    $('viewer-frame').setAttribute('src', url);
    $('viewer').hidden = false;
    document.body.style.overflow = 'hidden';
    $('viewer-close').focus();
  }
  function closeViewer() {
    $('viewer').hidden = true;
    $('viewer-frame').setAttribute('src', 'about:blank');
    document.body.style.overflow = '';
  }

  /* ================================================================== *
   * 配置区
   * ================================================================== */
  function canEdit() {
    if (!S.settings || S.settings.configEditor === false) return false;
    if (IS_GUOBA) return true;          // 锅巴已鉴权
    return !!S.settings.secured;        // 独立页必须先设口令
  }

  function openDrawer(tab) {
    $('drawer').hidden = false;
    document.body.style.overflow = 'hidden';
    switchTab(tab || cfgTab);
    loadConfig();
    $('cfg-close').focus();
  }
  function closeDrawer(force) {
    // 有未保存改动时确认一下，避免误点遮罩丢掉十分钟的编辑
    var dirty = isDirty();
    var go = function () {
      $('drawer').hidden = true;
      document.body.style.overflow = '';
    };
    if (!dirty || force) return go();
    confirmBox('配置有未保存的改动，确定放弃？').then(function (ok) {
      if (ok) go();
    });
  }

  function switchTab(name) {
    cfgTab = name === 'settings' ? 'settings' : 'routes';
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === cfgTab;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    $('pane-routes').hidden = cfgTab !== 'routes';
    $('pane-settings').hidden = cfgTab !== 'settings';
  }

  function loadConfig() {
    $('cfg-status').textContent = '读取中…';
    apiGet('/config').then(function (d) {
      renderConfig(d || {});
    }).catch(function (e) {
      $('cfg-status').textContent = '读取失败：' + e.message;
    });
  }

  function routeField(cls, label, val, ph, type) {
    return '<label><span>' + label + '</span><input class="' + cls + '" type="' + (type || 'text') +
      '" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph || '') + '"></label>';
  }

  function routeRow(r) {
    var d = document.createElement('div');
    d.className = 'rt';
    d.innerHTML =
      '<div class="rt-top">' +
        '<input class="rt-name" type="text" placeholder="名称（如 GsCore 面板）" value="' + esc(r.name || '') + '">' +
        '<label class="rt-enable"><input type="checkbox" class="rt-enable-cb"' + (r.enable ? ' checked' : '') + '>启用</label>' +
        '<button class="rt-del" type="button" title="删除这条路由">删除</button>' +
      '</div>' +
      '<div class="rt-grid">' +
        routeField('rt-matchPath', '匹配路径', r.matchPath, '/memes') +
        routeField('rt-host', 'host', r.host || '127.0.0.1', '127.0.0.1') +
        routeField('rt-port', '端口', r.port, '3132', 'number') +
        routeField('rt-prefix', '目标前缀', r.prefix == null ? '/' : r.prefix, '/app（/ = 剥掉前缀）') +
        routeField('rt-matchReferer', '来源包含', r.matchReferer, '留空 = 不限') +
        routeField('rt-matchMethod', '方法', r.matchMethod, 'GET|POST') +
        '<label><span>导航入口</span><select class="rt-entry">' +
          '<option value=""' + (r.entry === undefined ? ' selected' : '') + '>自动</option>' +
          '<option value="1"' + (r.entry === true ? ' selected' : '') + '>显示</option>' +
          '<option value="0"' + (r.entry === false ? ' selected' : '') + '>隐藏</option>' +
        '</select></label>' +
        // 两个开关合成一格：都是布尔项，单独各占 1/4 格会让右侧留出两片空白，
        // 还得硬凑 padding 去和输入框对齐
        '<div class="rt-flags"><span>开关</span><div class="fl">' +
          '<label class="chk" title="该服务需要 WebSocket（如 NapCat 实时日志）时打开">' +
            '<input type="checkbox" class="rt-ws"' + (r.ws ? ' checked' : '') + '>WS</label>' +
          '<label class="chk" title="页面里的前端代码用绝对路径 /api/... 发请求时，自动把 /api 分到这个后端">' +
            '<input type="checkbox" class="rt-autoApi"' + (r.autoApi ? ' checked' : '') + '>自动 /api</label>' +
        '</div></div>' +
        // 整行：只给「页面把 token 放 URL、接口只认 header」的现成页面用，平时留空。
        // 放最后是为了不打乱上面两行 4+4 的排布（grid dense 会把整行项挤到别处）
        '<label class="rt-wide"><span>凭证头（从来源页地址的 ?token= 补，留空不补）</span>' +
          '<input class="rt-refererTokenHeader" type="text" placeholder="留空 = 不补（如 guoba-access-token）" value="' + esc(r.refererTokenHeader || '') + '">' +
        '</label>' +
      '</div>';
    d.querySelector('.rt-del').addEventListener('click', function () {
      var host = d.querySelector('.rt-host').value || '127.0.0.1';
      var port = d.querySelector('.rt-port').value || '?';
      var name = d.querySelector('.rt-name').value || d.querySelector('.rt-matchPath').value || '这条路由';
      confirmBox('删除「' + name + '」→ ' + host + ':' + port + '？').then(function (ok) {
        if (ok) { d.remove(); markDirty(); }
      });
    });
    // 任何改动都标记成"未保存"，底栏与标题会变
    d.addEventListener('input', markDirty);
    d.addEventListener('change', markDirty);
    return d;
  }

  function renderConfig(d) {
    $('cfg-autoReload').checked = !!d.autoReload;
    $('cfg-debug').checked = !!d.debug;
    $('cfg-statusPage').checked = !!d.statusPage;
    $('cfg-allowEmbed').checked = d.allowEmbed !== false;
    $('cfg-configEditor').checked = d.configEditor !== false;
    $('cfg-refererSameOriginOnly').checked = d.refererSameOriginOnly !== false;
    $('cfg-trailingSlashRedirect').checked = d.trailingSlashRedirect !== false;
    $('cfg-quietProxyLog').checked = d.quietProxyLog !== false;
    $('cfg-quietExtraPaths').value = (d.quietExtraPaths || []).join(',');
    $('cfg-proxyTimeout').value = d.proxyTimeout || 30000;
    $('cfg-statusToken').value = d.statusToken || '';

    var box = $('cfg-routes');
    box.innerHTML = '';
    (d.routes || []).forEach(function (r) { box.appendChild(routeRow(r)); });
    $('tab-cnt').textContent = (d.routes || []).length;

    var note = $('cfg-note');
    if (!canEdit()) {
      note.hidden = false;
      note.textContent = IS_GUOBA
        ? '配置编辑已在设置中关闭（configEditor）。可以在这里查看，但不能保存。'
        : '当前没有设置访问口令，为防止公网误改，配置区只读。请先在锅巴面板设置口令，或在锅巴面板里编辑。';
      $('cfg-save').disabled = true;
    } else {
      note.hidden = true;
      $('cfg-save').disabled = false;
    }
    // 读完才拍快照 —— 快照必须在渲染之后，否则一打开就显示"未保存"
    cfgSnap = snapshot();
    $('cfg-status').textContent = '';
    setDirtyUI(false);
  }

  function collectConfig() {
    var rows = $('cfg-routes').querySelectorAll('.rt');
    var routes = [];
    for (var i = 0; i < rows.length; i++) {
      var el0 = rows[i];
      var entrySel = el0.querySelector('.rt-entry').value;
      var r = {
        enable: el0.querySelector('.rt-enable-cb').checked,
        name: el0.querySelector('.rt-name').value.trim(),
        matchPath: el0.querySelector('.rt-matchPath').value.trim(),
        matchReferer: el0.querySelector('.rt-matchReferer').value.trim(),
        matchMethod: el0.querySelector('.rt-matchMethod').value.trim(),
        host: el0.querySelector('.rt-host').value.trim(),
        port: Number(el0.querySelector('.rt-port').value) || 0,
        prefix: el0.querySelector('.rt-prefix').value.trim(),
        ws: el0.querySelector('.rt-ws').checked,
        autoApi: el0.querySelector('.rt-autoApi').checked,
        refererTokenHeader: el0.querySelector('.rt-refererTokenHeader').value.trim(),
      };
      if (entrySel === '1') r.entry = true;
      else if (entrySel === '0') r.entry = false;
      routes.push(r);
    }
    return {
      autoReload: $('cfg-autoReload').checked,
      debug: $('cfg-debug').checked,
      statusPage: $('cfg-statusPage').checked,
      allowEmbed: $('cfg-allowEmbed').checked,
      configEditor: $('cfg-configEditor').checked,
      refererSameOriginOnly: $('cfg-refererSameOriginOnly').checked,
      trailingSlashRedirect: $('cfg-trailingSlashRedirect').checked,
      quietProxyLog: $('cfg-quietProxyLog').checked,
      quietExtraPaths: $('cfg-quietExtraPaths').value,
      proxyTimeout: Number($('cfg-proxyTimeout').value) || 30000,
      statusToken: $('cfg-statusToken').value,
      routes: routes,
    };
  }

  function snapshot() {
    try {
      return JSON.stringify(collectConfig());
    } catch (e) {
      return '';
    }
  }
  function isDirty() {
    return !!cfgSnap && snapshot() !== cfgSnap;
  }
  function setDirtyUI(dirty) {
    var s = $('cfg-save');
    if (s) {
      s.textContent = dirty ? '保存并应用 ·' : '保存并应用';
      s.classList.toggle('dirty', dirty);
    }
    var sub = $('dh-sub');
    if (sub) sub.textContent = dirty ? '有未保存的改动' : '全局设置与路由';
  }
  function markDirty() {
    setDirtyUI(isDirty());
  }

  function saveConfig() {
    if (!canEdit()) return;
    var data = collectConfig();
    var empty = !data.routes.length;
    var go = function () {
      $('cfg-save').disabled = true;
      $('cfg-status').textContent = '保存中…';
      apiSend('/config', data).then(function (d) {
        $('cfg-status').textContent = d.message || '已保存';
        toast(d.message || '已保存并生效');
        cfgSnap = JSON.stringify(data);
        setDirtyUI(false);
        $('tab-cnt').textContent = data.routes.length;
        pull();
        // 保存成功就直接关掉抽屉：留在原地的下一步动作通常是"关掉它"
        setTimeout(closeDrawer.bind(null, true), 350);
      }).catch(function (e) {
        $('cfg-status').textContent = '保存失败：' + e.message;
        toast('保存失败：' + e.message, 'err');
      }).then(function () {
        $('cfg-save').disabled = !canEdit();
      });
    };
    if (empty) confirmBox('路由列表为空，保存后将没有任何挂载，确定继续？').then(function (ok) { if (ok) go(); });
    else go();
  }

  function addRoute() {
    var box = $('cfg-routes');
    var row = routeRow({ enable: true, matchPath: '/', matchReferer: '', matchMethod: '', host: '127.0.0.1', port: '', prefix: '/', ws: false });
    box.appendChild(row);
    switchTab('routes');
    $('tab-cnt').textContent = box.querySelectorAll('.rt').length;
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var mp = row.querySelector('.rt-matchPath');
    if (mp) { mp.focus(); mp.select(); }
    markDirty();
  }

  /* ================================================================== *
   * 交互绑定
   * ================================================================== */
  var ths = document.querySelectorAll('th[data-k]');
  for (var i = 0; i < ths.length; i++) {
    ths[i].addEventListener('click', function () {
      var k = this.getAttribute('data-k');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      for (var j = 0; j < ths.length; j++) {
        ths[j].classList.toggle('on', ths[j] === this);
        var a = ths[j].querySelector('.arrow');
        if (a) a.textContent = ths[j] === this ? (sortDir > 0 ? '▲' : '▼') : '▲';
      }
      renderRows();
    });
    // 补上排序箭头占位，避免点击时列宽跳动
    if (!ths[i].querySelector('.arrow')) {
      var ar = el('span', 'arrow', '▲');
      ths[i].appendChild(ar);
    }
  }

  $('q').addEventListener('input', function () { kw = this.value.trim(); renderRows(); });

  $('btn-refresh').addEventListener('click', function () { pull(true); });
  $('btn-more').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
  $('menu').addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', closeMenu);

  $('btn-reload').addEventListener('click', function () { closeMenu(); act('/reload', '已重载'); });
  $('btn-reset').addEventListener('click', function () {
    closeMenu();
    confirmBox('清空所有请求统计？路由配置不受影响。').then(function (ok) { if (ok) act('/reset', '统计已清空'); });
  });

  var btnCfg = $('btn-config');
  if (btnCfg) btnCfg.addEventListener('click', function () { openDrawer('routes'); });

  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener('click', function () { switchTab(this.getAttribute('data-tab')); });
  }

  $('cfg-close').addEventListener('click', function () { closeDrawer(); });
  $('drawer-mask').addEventListener('click', function () { closeDrawer(); });
  $('cfg-add').addEventListener('click', addRoute);
  $('cfg-reload').addEventListener('click', function () { loadConfig(); toast('已还原为磁盘上的配置'); });
  $('cfg-save').addEventListener('click', saveConfig);

  // 全局设置里的输入也要触发 dirty 标记
  var cfgPane = $('pane-settings');
  cfgPane.addEventListener('input', markDirty);
  cfgPane.addEventListener('change', markDirty);

  $('viewer-close').addEventListener('click', closeViewer);

  // 确认条按钮
  $('cf-ok').addEventListener('click', function () { settleConfirm(true); });
  $('cf-no').addEventListener('click', function () { settleConfirm(false); });

  /* 键盘：
     Esc    关掉最上层的浮层
     R/F/G  刷新 / 聚焦搜索 / 打开配置（输入框里打字时不触发） */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!$('confirm').hidden) return settleConfirm(false);
      if (!$('menu').hidden) return closeMenu();
      if (!$('viewer').hidden) return closeViewer();
      if (!$('drawer').hidden) return closeDrawer();
      return;
    }
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); pull(true); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); $('q').focus(); $('q').select(); }
    else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); if (canEdit()) openDrawer('routes'); }
  });

  // 顶栏吸顶时才加投影（CSS 里静止态是透明的，避免和内容"打架"）
  window.addEventListener('scroll', function () {
    var top = document.querySelector('.top');
    if (top) top.classList.toggle('stuck', window.scrollY > 6);
  }, { passive: true });

  // 退出登录只在独立页有意义；锅巴面板里由锅巴自己管登录
  var lo = $('btn-logout');
  if (lo) {
    if (IS_GUOBA) lo.style.display = 'none';
    else lo.setAttribute('href', PATH + '/logout');
  }

  var auto = $('auto');
  function startAuto() {
    if (timer) clearInterval(timer);
    if (auto.checked) timer = setInterval(function () {
      // 查看器/抽屉/确认条打开时暂停刷新，避免打扰
      if (!document.hidden && $('viewer').hidden && $('drawer').hidden && $('confirm').hidden) pull();
    }, 3000);
  }
  auto.addEventListener('change', startAuto);

  if (window.__WM__) render(window.__WM__);
  pull();
  startAuto();
})();
