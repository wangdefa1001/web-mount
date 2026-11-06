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

  function $(id) { return document.getElementById(id); }
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
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
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

  /* ---------- 渲染 ---------- */
  function renderCards(t) {
    var items = [
      ['路由总数', num(t.routes), '', ''],
      ['后端在线', num(t.online), t.online === t.routes ? 'ok' : (t.online ? '' : 'bad'), '/' + num(t.routes)],
      ['累计请求', num(t.req), '', ''],
      ['累计错误', num(t.err), t.err ? 'bad' : '', ''],
      ['平均耗时', t.avgMs ? dur(t.avgMs) : '—', '', '']
    ];
    var h = '';
    for (var i = 0; i < items.length; i++) {
      h += '<div class="card"><span>' + items[i][0] + '</span><b class="' + items[i][2] + '">' + items[i][1] +
        '</b>' + (items[i][3] ? '<em>' + items[i][3] + '</em>' : '') + '</div>';
    }
    $('cards').innerHTML = h;
  }

  function renderSites(list) {
    var el = $('sites');
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '<div class="sites-empty">暂无可作为入口的路由。给页面类路由打开「导航入口」，或去掉 /api、/ws 这类接口路径。</div>';
      return;
    }
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var ch = (s.name || '?').trim().charAt(0).toUpperCase();
      h += '<button class="site" type="button" data-i="' + i + '">' +
        '<span class="ic">' + esc(ch) + '</span>' +
        '<span class="smeta"><span class="nm2">' + esc(s.name) + '</span>' +
        '<span class="pth" title="' + esc(s.host + ':' + s.port) + '">' + esc(s.path) + '</span></span>' +
        '<span class="dot ' + (s.online ? 'ok' : 'bad') + '"></span>' +
        '</button>';
    }
    el.innerHTML = h;
    var btns = el.querySelectorAll('.site');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function () {
        var s = (S.services || [])[Number(this.getAttribute('data-i'))];
        if (s) openViewer(s);
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
      $('rows').innerHTML = '<tr><td colspan="7" class="empty">' +
        (all ? '没有匹配的路由' : '暂无启用的路由，去 config.json 或锅巴面板添加') + '</td></tr>';
      return;
    }
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var tags = '';
      if (r.matchReferer) tags += '<span class="tag">来源 ' + esc(r.matchReferer) + '</span>';
      if (r.matchMethod) tags += '<span class="tag">' + esc(r.matchMethod) + '</span>';
      if (r.ws) tags += '<span class="tag ws">WS</span>';
      if (r.auto) tags += '<span class="tag auto" title="由「自动 /api」派生，不写进 config.json">自动</span>';
      if (r.entry === true) tags += '<span class="tag entry">入口</span>';
      else if (r.entry === false && !r.auto) tags += '<span class="tag off">不进导航</span>';
      var stCls = r.lastStatus >= 400 ? 'st-err' : (r.lastStatus ? 'st-ok' : '');
      var target = esc(r.host) + ':' + esc(r.port) +
        (r.prefix && r.prefix !== '/' ? '<span style="opacity:.6">' + esc(r.prefix) + '</span>' : '');
      h += '<tr>' +
        '<td class="lead"><div class="nm"><span class="dot ' + (r.online ? 'ok' : 'bad') + '" title="' +
          (r.online ? '在线 · ' + r.ping + 'ms' : '无法连接') + '"></span>' + esc(r.name) + '</div>' +
          '<div class="tags"><code>' + esc(r.matchPath) + '</code>' + tags + '</div></td>' +
        '<td data-l="目标"><code>' + target + '</code></td>' +
        '<td class="num" data-l="请求">' + num(r.count) + '</td>' +
        '<td class="num ' + (r.errors ? 'err-n' : '') + '" data-l="错误">' + (r.errors || '—') + '</td>' +
        '<td class="num ' + stCls + '" data-l="状态">' + (r.lastStatus || '—') + '</td>' +
        '<td class="num" data-l="耗时">' + dur(r.lastMs) + '</td>' +
        '<td class="num hide-sm" data-l="最近" style="opacity:.75">' + time(r.lastAt) + '</td>' +
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
    if (btn) btn.hidden = !(S.settings && S.settings.configEditor !== false);
  }

  function pull() {
    fetchStatus().then(render).catch(function (e) {
      if (IS_GUOBA) {
        if (String(e.message) === '401') toast('锅巴登录已失效，请刷新面板');
        else toast('读取状态失败：' + e.message);
      } else if (String(e.message) === '401') {
        location.reload();
      }
    });
  }

  function act(sub, okMsg) {
    apiSend(sub).then(function (d) {
      toast(d.message || okMsg);
      pull();
    }).catch(function (e) {
      toast('操作失败' + (e && e.message ? '（' + e.message + '）' : ''));
    });
  }

  /* ---------- 页面查看器 ---------- */
  function openViewer(svc) {
    var url = BASE + svc.path;
    $('viewer-title').textContent = svc.name + ' · ' + url;
    $('viewer-open').setAttribute('href', url);
    $('viewer-frame').setAttribute('src', url);
    $('viewer').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeViewer() {
    $('viewer').hidden = true;
    $('viewer-frame').setAttribute('src', 'about:blank');
    document.body.style.overflow = '';
  }

  /* ---------- 配置区 ---------- */
  function canEdit() {
    if (!S.settings || S.settings.configEditor === false) return false;
    if (IS_GUOBA) return true;          // 锅巴已鉴权
    return !!S.settings.secured;        // 独立页必须先设口令
  }

  function openDrawer() {
    $('drawer').hidden = false;
    document.body.style.overflow = 'hidden';
    loadConfig();
  }
  function closeDrawer() {
    $('drawer').hidden = true;
    document.body.style.overflow = '';
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
        '<button class="rt-del" type="button">删除</button>' +
      '</div>' +
      '<div class="rt-grid">' +
        routeField('rt-matchPath', '匹配路径', r.matchPath, '/memes') +
        routeField('rt-matchReferer', '来源包含', r.matchReferer, '留空=不限') +
        routeField('rt-matchMethod', '方法', r.matchMethod, 'GET|POST') +
        routeField('rt-host', 'host', r.host || '127.0.0.1', '127.0.0.1') +
        routeField('rt-port', '端口', r.port, '3132', 'number') +
        routeField('rt-prefix', '目标前缀', r.prefix, '/app') +
        '<label><span>导航入口</span><select class="rt-entry">' +
          '<option value=""' + (r.entry === undefined ? ' selected' : '') + '>自动</option>' +
          '<option value="1"' + (r.entry === true ? ' selected' : '') + '>显示</option>' +
          '<option value="0"' + (r.entry === false ? ' selected' : '') + '>隐藏</option>' +
        '</select></label>' +
        '<label class="chk"><input type="checkbox" class="rt-ws"' + (r.ws ? ' checked' : '') + '>WebSocket</label>' +
        '<label class="chk" title="页面里的前端代码用绝对路径 /api/... 发请求时，自动把 /api 分到这个后端">' +
          '<input type="checkbox" class="rt-autoApi"' + (r.autoApi ? ' checked' : '') + '>自动 /api</label>' +
      '</div>';
    d.querySelector('.rt-del').addEventListener('click', function () { d.remove(); });
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
    $('cfg-proxyTimeout').value = d.proxyTimeout || 30000;
    $('cfg-statusToken').value = d.statusToken || '';

    var box = $('cfg-routes');
    box.innerHTML = '';
    (d.routes || []).forEach(function (r) { box.appendChild(routeRow(r)); });

    var note = $('cfg-note');
    if (!canEdit()) {
      note.hidden = false;
      note.textContent = IS_GUOBA
        ? '配置编辑已在设置中关闭（configEditor）。可以在这里查看，但不能保存。'
        : '当前没有设置访问口令，为防止公网误改，配置区只读。请先在锅巴面板设置口令，或直接在锅巴面板里编辑。';
      $('cfg-save').disabled = true;
    } else {
      note.hidden = true;
      $('cfg-save').disabled = false;
    }
    $('cfg-status').textContent = '';
  }

  function collectConfig() {
    var rows = $('cfg-routes').querySelectorAll('.rt');
    var routes = [];
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      var entrySel = el.querySelector('.rt-entry').value;
      var r = {
        enable: el.querySelector('.rt-enable-cb').checked,
        name: el.querySelector('.rt-name').value.trim(),
        matchPath: el.querySelector('.rt-matchPath').value.trim(),
        matchReferer: el.querySelector('.rt-matchReferer').value.trim(),
        matchMethod: el.querySelector('.rt-matchMethod').value.trim(),
        host: el.querySelector('.rt-host').value.trim(),
        port: Number(el.querySelector('.rt-port').value) || 0,
        prefix: el.querySelector('.rt-prefix').value.trim(),
        ws: el.querySelector('.rt-ws').checked,
        autoApi: el.querySelector('.rt-autoApi').checked,
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
      proxyTimeout: Number($('cfg-proxyTimeout').value) || 30000,
      statusToken: $('cfg-statusToken').value,
      routes: routes,
    };
  }

  function saveConfig() {
    if (!canEdit()) return;
    var data = collectConfig();
    if (!data.routes.length && !confirm('路由列表为空，保存后将没有任何挂载，确定继续？')) return;

    $('cfg-save').disabled = true;
    $('cfg-status').textContent = '保存中…';
    apiSend('/config', data).then(function (d) {
      $('cfg-status').textContent = d.message || '已保存';
      toast(d.message || '已保存并生效');
      pull();
    }).catch(function (e) {
      $('cfg-status').textContent = '保存失败：' + e.message;
      toast('保存失败');
    }).then(function () {
      $('cfg-save').disabled = !canEdit();
    });
  }

  function addRoute() {
    var box = $('cfg-routes');
    var row = routeRow({ enable: true, matchPath: '', matchReferer: '', matchMethod: '', host: '127.0.0.1', port: '', prefix: '/', ws: false });
    box.appendChild(row);
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var mp = row.querySelector('.rt-matchPath');
    if (mp) mp.focus();
  }

  /* ---------- 交互绑定 ---------- */
  var ths = document.querySelectorAll('th[data-k]');
  for (var i = 0; i < ths.length; i++) {
    ths[i].addEventListener('click', function () {
      var k = this.getAttribute('data-k');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      for (var j = 0; j < ths.length; j++) {
        ths[j].classList.toggle('on', ths[j] === this);
        var a = ths[j].querySelector('.arrow');
        if (a) a.textContent = (ths[j] === this ? (sortDir > 0 ? '▲' : '▼') : '▲');
      }
      renderRows();
    });
  }

  $('q').addEventListener('input', function () { kw = this.value.trim(); renderRows(); });
  $('btn-refresh').addEventListener('click', function () { pull(); toast('已刷新'); });
  $('btn-reload').addEventListener('click', function () { act('/reload', '已重载'); });
  $('btn-reset').addEventListener('click', function () {
    if (confirm('确定清空所有请求统计？')) act('/reset', '统计已清空');
  });

  var btnCfg = $('btn-config');
  if (btnCfg) btnCfg.addEventListener('click', openDrawer);
  $('cfg-close').addEventListener('click', closeDrawer);
  $('drawer-mask').addEventListener('click', closeDrawer);
  $('cfg-add').addEventListener('click', addRoute);
  $('cfg-reload').addEventListener('click', loadConfig);
  $('cfg-save').addEventListener('click', saveConfig);

  $('viewer-close').addEventListener('click', closeViewer);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('viewer').hidden) closeViewer();
    else if (!$('drawer').hidden) closeDrawer();
  });

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
      // 查看器/抽屉打开时暂停刷新，避免打扰
      if (!document.hidden && $('viewer').hidden && $('drawer').hidden) pull();
    }, 3000);
  }
  auto.addEventListener('change', startAuto);

  if (window.__WM__) render(window.__WM__);
  pull();
  startAuto();
})();
