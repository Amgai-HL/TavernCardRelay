// ═══════════════════════════════════════════════════════════════════
// 反截断·自动放行守卫   auto-unblock.js   v1.0.0
// ───────────────────────────────────────────────────────────────────
// 装一次，之后全自动：不需要改任何角色卡/助手脚本的源码，不需要逐张卡处理。
//
// 工作原理：任何"静默截断"都要先劫持 window.fetch。本脚本常驻在父页面，
//   ① 启动时清掉已经装上的拦截层
//   ② 之后每 250ms 巡检一次，谁再装钩子就在下一次请求前被摘掉
//   ③ 只摘"能认出是拦截器"的层，其他插件正常的 fetch 包装（加请求头、
//      记日志之类）原样保留，不会误伤
//
// 装法：酒馆助手 → 脚本库 → 新建脚本 → 类型「全局」，内容一行：
//   import 'https://cdn.jsdelivr.net/gh/你的用户名/你的仓库@main/auto-unblock.js'
//
// 不需要任何配置。装上就生效，控制台会打印 [自动放行] 日志。
//
// 控制台 API：
//   jmzqGuard.report()        看当前 fetch 链条、已清掉多少层
//   jmzqGuard.showPanel()     显示状态小面板（默认隐藏）
//   jmzqGuard.sweep()         立刻手动巡检一次
//   jmzqGuard.aggressive(true) 激进模式：连认不出的 fetch 包装层也一起摘
//                             （默认关闭；开启后可能影响别的扩展，谨慎）
//   jmzqGuard.off() / on()    临时关闭 / 打开自动清理
//   jmzqGuard.uninstall()     彻底卸载本脚本
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var TAG = '[自动放行]';
  var POLL = 250;                       // 巡检间隔（毫秒）
  var STORE = 'jmzqGuardState';

  // ── 定位要守护的窗口 ────────────────────────────────────────────
  var p;
  try { p = window.parent && window.parent !== window ? window.parent : window; }
  catch (e) { p = window; }
  if (!p || !p.document) p = window;

  // ── 识别"拦截器"的特征 ──────────────────────────────────────────
  // 说明：黑名单逻辑藏在闭包里，从函数源码看不出来。所以用两类线索：
  //   ① 这个脚本体系留下的标记名（_jmzq… / fetchHook / InjectFetch…）
  //   ② 父页面上的全局痕迹（_jmzqFetchHook / _jmzqFetchOriginal 等）
  var MARKERS = [
    '_jmzqfetchoriginal', '_jmzqfetchhook', 'jmzq', 'fetchhook', 'fetch_hook',
    'injectfetch', 'inject_fetch', 'originalfetch', 'original_fetch',
    'fetchoriginal', 'fakecompletion', 'config_blacklist', 'config_url_blacklist',
    'ewcrestorefetchhook', 'ewcinjectfetchhook', 'unblock', 'allowall', 'allow_all',
  ];
  var GLOBAL_KEYS = [
    '_jmzqFetchOriginal', '_jmzqFetchHook', '_jmzqFetchPass', '_jmzqAllowAll',
    'jmzqAllowAll', 'jmzqGuard',
  ];

  function isFn(f) { return typeof f === 'function'; }

  function fnText(f) {
    try { return String(f).slice(0, 4000).toLowerCase(); } catch (e) { return ''; }
  }
  function fnName(f) {
    try { return String(f.name || '').toLowerCase(); } catch (e) { return ''; }
  }

  // 这一层是不是"能明确认出的拦截器"？
  // 注意：绝不能因为"父页面上存在助手的痕迹"就摘当前层——那样会把良性包装层
  // 甚至原生 fetch 自己都摘掉（早期版本踩过这个坑）。只认这一层自己的特征。
  var STRONG_MARKERS = [
    '_jmzqfetchoriginal', '_jmzqfetchhook', 'jmzqfetch', 'jmzqinject', 'jmzqrestore',
    'fetchhook', 'fetch_hook', 'injectfetch', 'inject_fetch', 'hookfetch',
    'originalfetch', 'original_fetch', 'fetchoriginal', 'fakecompletion',
  ];
  function looksLikeInterceptor(win, fn) {
    if (!isFn(fn)) return false;
    // 最硬的证据：这个体系把"当前钩子"记在了全局变量上（卸载时要认它）
    try {
      if (win && win._jmzqFetchHook === fn) return 'identity:_jmzqFetchHook';
      if (win && win._jmzqFetchPass === fn) return 'identity:_jmzqFetchPass';
    } catch (e) {}
    var name = fnName(fn);
    var text = fnText(fn);
    for (var i = 0; i < STRONG_MARKERS.length; i++) {
      var m = STRONG_MARKERS[i];
      if (name.indexOf(m) !== -1) return 'name:' + m;
      if (text.indexOf(m) !== -1) return 'src:' + m;
    }
    // 这一层自己身上带着助手体系的标记
    try {
      if (isFn(fn.__jmzqFetchOriginal)) return 'src:__jmzqFetchOriginal';
      if (isFn(fn.__jmzqFetchHook)) return 'src:__jmzqFetchHook';
      if (fn.__jmzqPass === true) return 'mark:__jmzqPass';
    } catch (e) {}
    return false;
  }

  // 弱判定：只用来在面板里提示"这里可能有拦截体系"，不用于摘层
  function suspicious(win, fn) {
    if (!isFn(fn)) return false;
    for (var j = 0; j < GLOBAL_KEYS.length; j++) {
      try { if (win[GLOBAL_KEYS[j]] !== undefined) return 'global:' + GLOBAL_KEYS[j]; } catch (e) {}
    }
    return false;
  }

  // ── 状态 ────────────────────────────────────────────────────────
  var state = { on: true, aggressive: false, cleaned: 0, lastClean: 0, seen: [], version: VERSION };
  try {
    var saved = JSON.parse(p.localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') {
      state.on = saved.on !== false;
      state.aggressive = saved.aggressive === true;
    }
  } catch (e) {}
  function persist() {
    try { p.localStorage.setItem(STORE, JSON.stringify({ on: state.on, aggressive: state.aggressive })); } catch (e) {}
  }

  var targets = [];
  function addTarget(w) {
    if (!w || !w.document || w.__jmzqGuardBound) return null;
    var bag = { win: w, justInstalled: false, cleaned: 0, lastLayer: '' };
    targets.push(bag);
    try { w.__jmzqGuardBound = true; } catch (e) {}
    return bag;
  }
  addTarget(p);
  if (window !== p) addTarget(window);

  function log(force) {
    try {
      var args = Array.prototype.slice.call(arguments, 1);
      args.unshift(TAG);
      if (force) console.log.apply(console, args);
      else if (p.__jmzqGuardDebug) console.log.apply(console, args);
    } catch (e) {}
  }

  // 找出这一层"被包住的下层"
  function underlyingLayer(win, fn) {
    // 我们自己装过的层：优先用助手体系留下的原生引用，其次才是它保存的下层
    if (isFn(fn) && fn.__jmzqPass === true) {
      try { if (isFn(win._jmzqFetchOriginal) && win._jmzqFetchOriginal !== win.fetch) return win._jmzqFetchOriginal; } catch (e) {}
      if (isFn(fn.__jmzqPrev)) return fn.__jmzqPrev;
      try { if (isFn(win._jmzqFetchOriginal)) return win._jmzqFetchOriginal; } catch (e) {}
      return null;
    }
    // 助手体系自己留的后门
    try {
      if (isFn(win._jmzqFetchOriginal) && win._jmzqFetchOriginal !== win.fetch) return win._jmzqFetchOriginal;
    } catch (e) {}
    // 常见命名约定
    var cands = ['__jmzqPrev', '__original', '__prev', '_prev', '__orig', 'original', '__jmzqOriginal', '__native', '__raw'];
    for (var i = 0; i < cands.length; i++) {
      try { if (isFn(fn[cands[i]])) return fn[cands[i]]; } catch (e) {}
    }
    return null;
  }

  function sweepBag(bag, manual) {
    var win = bag.win;
    if (!isFn(win.fetch)) return false;
    if (win.fetch.__jmzqPass === true) return false;      // 已经是放行层，别再动
    var reason = looksLikeInterceptor(win, win.fetch);
    if (!reason && !state.aggressive) return false;
    var under = underlyingLayer(win, win.fetch);
    if (!isFn(under)) {
      if (manual) log(true, '发现可疑层但没有可回退的下层，跳过：', String(win.fetch).slice(0, 80));
      return false;
    }
    var beforeText = String(win.fetch).slice(0, 120).replace(/\s+/g, ' ');
    try {
      win.fetch = under;
      if (win.fetch !== under) Object.defineProperty(win, 'fetch', { value: under, writable: true, configurable: true });
    } catch (e) { return false; }
    // 只有确认当前层不是助手的钩子了，才清掉它的引用，避免它的"卸载"逻辑乱还原
    try {
      if (win._jmzqFetchHook === undefined || win._jmzqFetchHook !== win.fetch) delete win._jmzqFetchHook;
    } catch (e) {}
    bag.cleaned++;
    state.cleaned++;
    state.lastClean = Date.now();
    state.seen.unshift({ at: new Date().toLocaleTimeString(), reason: reason || 'aggressive', layer: beforeText });
    if (state.seen.length > 30) state.seen.pop();
    log(true, '已摘掉拦截层（' + (reason || '激进模式') + '）：' + beforeText);
    render();
    return true;
  }

  function sweep(manual) {
    if (!state.on && !manual) return 0;
    var n = 0;
    for (var i = 0; i < targets.length; i++) if (sweepBag(targets[i], manual)) n++;
    return n;
  }

  // ── 状态小面板（默认隐藏） ───────────────────────────────────────
  var PANEL_ID = 'jmzq-guard-panel';
  var panel = null, bodyEl = null;

  function buildPanel() {
    if (panel && panel.isConnected) return panel;
    var d = p.document;
    panel = d.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;width:300px;display:none;' +
      'flex-direction:column;background:linear-gradient(175deg,#f7f3ea,#efe8da);color:#3a2a18;' +
      'border:1px solid rgba(0,0,0,.12);border-radius:6px;box-shadow:0 10px 34px rgba(0,0,0,.28);' +
      'font:12px/1.55 "Microsoft YaHei",system-ui,sans-serif;user-select:none;overflow:hidden';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;' +
      'background:rgba(74,122,58,.08);border-bottom:1px solid rgba(0,0,0,.07)">' +
      '<b style="letter-spacing:1px;color:#3f6b32">反截断 · 自动放行</b>' +
      '<span id="jmzq-guard-x" style="cursor:pointer;font-size:14px;color:#8a7060">✕</span></div>' +
      '<div id="jmzq-guard-body" style="padding:10px 12px;max-height:46vh;overflow:auto"></div>';
    d.body.appendChild(panel);
    bodyEl = panel.querySelector('#jmzq-guard-body');
    panel.querySelector('#jmzq-guard-x').addEventListener('click', hidePanel);
    return panel;
  }
  function row(ok, label, value) {
    var c = ok ? '#4a7a3a' : (ok === false ? '#c04030' : '#8a7060');
    return '<div style="display:flex;gap:6px;margin:3px 0"><span style="color:' + c + ';flex:none">●</span>' +
      '<span style="color:#8a7060;flex:none;min-width:84px">' + label + '</span><span style="word-break:break-all">' + value + '</span></div>';
  }
  function render() {
    if (!panel || panel.style.display === 'none' || !bodyEl) return;
    var chain = [];
    for (var i = 0; i < targets.length; i++) {
      var w = targets[i].win;
      var t = String(w.fetch).replace(/\s+/g, ' ').slice(0, 60);
      chain.push(row(w.fetch.__jmzqPass !== true, w === p ? '父页面' : '本框架', t));
    }
    bodyEl.innerHTML =
      row(state.on, '自动清理', state.on ? '开启（每 ' + POLL + 'ms 巡检）' : '已关闭') +
      row(null, '已摘层数', state.cleaned + ' 层' + (state.lastClean ? '（最近 ' + new Date(state.lastClean).toLocaleTimeString() + '）' : '')) +
      chain.join('') +
      (state.seen.length ? '<div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(0,0,0,.07);font-size:11px;color:#8a7060">最近记录：<br>' +
        state.seen.slice(0, 6).map(function (s) { return '· ' + s.at + ' ' + s.reason; }).join('<br>') + '</div>' : '') +
      '<div style="margin-top:8px;font-size:11px;color:#a09080">控制台：jmzqGuard.report() / aggressive(true) / off()</div>';
  }
  function showPanel() { buildPanel(); panel.style.display = 'flex'; render(); }
  function hidePanel() { if (panel) panel.style.display = 'none'; }

  // ── 对外 API ────────────────────────────────────────────────────
  function report() {
    var res = { version: VERSION, on: state.on, aggressive: state.aggressive, cleaned: state.cleaned, chains: [] };
    for (var i = 0; i < targets.length; i++) {
      var w = targets[i].win;
      var chain = [], f = w.fetch, hop = 0;
      while (isFn(f) && hop < 6) {
        chain.push({ layer: hop, name: fnName(f) || '(匿名)', isMine: f.__jmzqPass === true, head: String(f).slice(0, 70).replace(/\s+/g, ' ') });
        f = underlyingLayer(w, f); hop++;
      }
      res.chains.push({ where: w === p ? 'parent' : 'iframe', layers: chain, suspicious: suspicious(w, w.fetch) || false });
    }
    try { console.log(TAG + ' 状态：', res); } catch (e) {}
    render();
    return res;
  }

  var API = {
    version: VERSION,
    report: report,
    sweep: function () { var n = sweep(true); report(); return n; },
    showPanel: showPanel,
    hidePanel: hidePanel,
    on: function () { state.on = true; persist(); log(true, '自动清理已开启'); try { sweep(true); } catch (e) {} render(); return true; },
    off: function () { state.on = false; persist(); log(true, '自动清理已关闭（已有钩子不会被摘掉）'); render(); return false; },
    aggressive: function (v) {
      state.aggressive = v !== false;
      persist();
      log(true, '激进模式：' + (state.aggressive ? '开（连认不出的 fetch 包装也会摘）' : '关'));
      render();
      return state.aggressive;
    },
    debug: function (v) { p.__jmzqGuardDebug = v !== false; return p.__jmzqGuardDebug; },
    uninstall: function () {
      clearInterval(timer);
      try { p.removeEventListener('pagehide', onHide); } catch (e) {}
      if (panel) { try { panel.remove(); } catch (e2) {} panel = null; bodyEl = null; }
      try { delete p.jmzqGuard; } catch (e3) {}
      if (window !== p) { try { delete window.jmzqGuard; } catch (e4) {} }
      log(true, '已卸载（当前 fetch 保持现状）');
    },
  };
  try { p.jmzqGuard = API; } catch (e) {}
  try { if (window !== p) window.jmzqGuard = API; } catch (e2) {}

  // ── 启动 ────────────────────────────────────────────────────────
  var timer = setInterval(function () { sweep(false); }, POLL);
  function onHide() { try { clearInterval(timer); } catch (e) {} }
  try { p.addEventListener('pagehide', onHide); } catch (e3) {}

  var first = sweep(true);
  log(true, 'v' + VERSION + ' 已启动' + (first ? '，启动时摘掉 ' + first + ' 个拦截层' : '（当前无拦截层）') +
    '；每 ' + POLL + 'ms 巡检。控制台 jmzqGuard.report() 查看。');
})();
