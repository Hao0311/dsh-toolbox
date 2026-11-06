/**
 * dsh-toolbox — 客户端（注入进 index.html 的普通脚本，不依赖 React）。
 *
 * 第四版（0.5.0）目标：
 *   · 视觉与 DSH 原生一致：桌面端从右侧滑出的抽屉（不压黑、不挡聊天），手机端全屏；
 *   · 链路自动化：打开面板自动刷新连接状态、自动做一次「轻体检」；托盘式后台任务，
 *     关掉面板测速/监控继续跑，入口显示运行状态，左下角出现小进度条；
 *   · 新功能：网络质量监控（低流量采样找卡顿尖峰）、历史记录与对比、一键体检报告、
 *     自动巡检提醒（页面开着时定时轻探测，网络变差入口亮红点）。
 *
 * 约束（沿用《DSH 维护手册》手机端规则）：
 *   · 不改 DSH 顶层布局：所有样式都挂在 #dsh-toolbox-root / button.tbx-navrow 下；
 *   · 元素由脚本自己创建；脚本不运行 = 页面与官方原版完全一致；
 *   · 电脑端入口 = 左侧导航栏一行；手机端入口 = 抽屉里的同一行（用户明确要求，不要再加浮动按钮）；
 *   · React 重渲染冲掉入口时由 MutationObserver 自愈。
 *
 * 扩展方式（保留）：
 *   window.DSHToolbox.register({ id, title, hint, render(container) {...} });
 *   注册顺序即「更多工具」里的显示顺序。
 */
(() => {
  'use strict';
  if (window.__DSH_TOOLBOX_MOUNTED__ === true) return;
  window.__DSH_TOOLBOX_MOUNTED__ = true;

  const API = '/api/toolbox';
  const VERSION = '0.5.1';
  const LS_HISTORY = 'dsh-toolbox.history.v1';
  const LS_PREFS = 'dsh-toolbox.prefs.v1';
  const MAX_HISTORY = 40;

  /** 测速并发流数：单条 TCP 在这条链路上约 190 Mbps 封顶，多流才测得出真实带宽。 */
  const STREAMS = 4;

  /** 桌面端抽屉最大宽度（与 client.css 的 .tbx-panel 默认值一致）。 */
  const PANEL_WIDTH = 424;
  /** 桌面端窗口够宽才让位；更窄就退回悬浮（手机/超窄窗口）。 */
  const RESERVE_MIN_VIEW = 900;

  /** 桌面端面板宽度：窗口越窄越窄，最窄 340px。 */
  function panelWidth() {
    return Math.min(PANEL_WIDTH, Math.max(340, Math.round(window.innerWidth * 0.32)));
  }

  const SPEED_PRESETS = {
    fast: { label: '快速', downMb: 20, upMb: 10, seconds: 0, hint: '约 5 秒' },
    standard: { label: '标准', downMb: 100, upMb: 20, seconds: 0, hint: '约 10 秒' },
    extreme: { label: '极限', downMb: 500, upMb: 50, seconds: 0, hint: '约 30 秒' },
    timed: { label: '持续', downMb: 100, upMb: 20, seconds: 30, hint: '30 秒' },
  };
  const DOWN_CHOICES = [20, 50, 100, 200, 500, 1000];
  const UP_CHOICES = [10, 20, 50, 100];
  const MONITOR_CHOICES = [30, 60, 180];
  const PATROL_CHOICES = [3, 5, 10];

  const OK = 'ok';
  const WARN = 'warn';
  const BAD = 'bad';

  /* ------------------------------------------------------------------ 小工具 */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const kid of kids.flat(4)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function clock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function clockSec(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function dateTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function mbpsOf(bytes, ms) {
    if (!(bytes > 0) || !(ms > 0)) return null;
    return (bytes / 1048576) / (ms / 1000);
  }

  function fmtMBps(v) {
    return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} MB/s`;
  }

  function fmtMbps(v) {
    return v === null || v === undefined || !Number.isFinite(v) ? '' : `${(v * 8).toFixed(0)} Mbps`;
  }

  function fmtMs(v, digits = 1) {
    return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} ms`;
  }

  function fmtMB(bytes) {
    if (!(bytes > 0)) return '—';
    const mb = bytes / 1048576;
    return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  }

  function clampText(text, max) {
    const t = String(text ?? '');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function jsonGet(path) {
    return fetch(`${API}${path}`, { cache: 'no-store', credentials: 'same-origin' }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  function stopError() {
    const error = new Error('已停止');
    error.name = 'AbortError';
    return error;
  }

  function isAbort(error) {
    return !!error && (error.name === 'AbortError' || /已停止/.test(String(error.message)));
  }

  function verdictMeta(level) {
    if (level === BAD) return { level: BAD, label: '较差' };
    if (level === WARN) return { level: WARN, label: '一般' };
    return { level: OK, label: '良好' };
  }

  function worstLevel(items) {
    if (items.some((i) => i.level === BAD)) return BAD;
    if (items.some((i) => i.level === WARN)) return WARN;
    return OK;
  }

  /* ------------------------------------------------------------------ 状态 */

  function loadJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
  }

  const storedPrefs = loadJson(LS_PREFS, {});
  const prefs = Object.assign(
    { preset: 'standard', customDown: 100, customUp: 20, customSeconds: 0, monitorSec: 60, patrolEnabled: true, patrolMinutes: 5 },
    storedPrefs,
  );
  // 手机端默认关掉自动巡检（2026-11-03）：手机要靠电池和同一张 Wi-Fi，
  // 巡检每 5 分钟起一次下载/探测，和页面加载抢带宽、还周期性地占主线程。
  // 只改"从未显式设置过"的情况，用户在面板里主动打开仍然有效。
  const IS_HANDHELD = (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    || (Number(navigator.maxTouchPoints) > 0 && window.innerWidth < 1024);
  if (IS_HANDHELD && typeof storedPrefs.patrolEnabled !== 'boolean') prefs.patrolEnabled = false;
  if (!SPEED_PRESETS[prefs.preset]) prefs.preset = 'standard';
  if (!MONITOR_CHOICES.includes(Number(prefs.monitorSec))) prefs.monitorSec = 60;
  if (!PATROL_CHOICES.includes(Number(prefs.patrolMinutes))) prefs.patrolMinutes = 5;

  const savedHistory = loadJson(LS_HISTORY, []);
  const history = Array.isArray(savedHistory) ? savedHistory.filter((e) => e && e.kind && e.at) : [];

  function persistPrefs() { saveJson(LS_PREFS, prefs); }
  function persistHistory() { saveJson(LS_HISTORY, history.slice(0, MAX_HISTORY)); }

  function latestEntry(kind) { return history.find((e) => e.kind === kind) || null; }

  const S = {
    open: false,
    status: null,
    statusAt: 0,
    statusLoading: false,
    check: null,
    job: null,
    lastSpeed: latestEntry('speed'),
    lastMonitor: latestEntry('monitor'),
    history,
    patrol: { last: null, baseline: null, alert: false },
    toast: null,
    pill: null,
    pillTimer: 0,
    extras: [],
  };

  // 历史里如果还留着体检记录，就把最近一次恢复成当前体检结果（重启页面后不丢结论）。
  const savedCheck = latestEntry('check');
  if (savedCheck) S.check = savedCheck.data || null;

  const listeners = new Set();
  let renderTimer = 0;
  let lastRender = 0;

  function notifyListeners() {
    lastRender = Date.now();
    for (const fn of listeners) {
      try { fn(); } catch { /* 忽略 */ }
    }
  }

  function emit(force) {
    if (force) {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
      notifyListeners();
      return;
    }
    if (renderTimer) return;
    const wait = Math.max(0, 160 - (Date.now() - lastRender));
    renderTimer = Number(setTimeout(() => {
      renderTimer = 0;
      notifyListeners();
    }, wait));
  }

  /* ------------------------------------------------------------------ 网络测量 */

  let statusPromise = null;

  function ensureStatus(force) {
    if (!force && S.status && Date.now() - S.statusAt < 45000) return Promise.resolve(S.status);
    if (statusPromise) return statusPromise;
    S.statusLoading = true;
    emit();
    statusPromise = jsonGet(`/net/status?t=${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
      .then((data) => {
        S.status = data;
        S.statusAt = Date.now();
        return data;
      })
      .catch((error) => {
        S.statusError = String(error && error.message ? error.message : error);
        return null;
      })
      .finally(() => {
        S.statusLoading = false;
        statusPromise = null;
        emit();
      });
    return statusPromise;
  }

  function pid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 单次小请求测 RTT（宿主 /net/info 只回几十字节 JSON）。 */
  async function pingOnce(timeoutMs, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* 忽略 */ } }, timeoutMs);
    const forward = () => { try { ctrl.abort(); } catch { /* 忽略 */ } };
    if (signal) signal.addEventListener('abort', forward, { once: true });
    const started = performance.now();
    try {
      await fetch(`${API}/net/info?t=${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      return performance.now() - started;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
    }
  }

  function latencyStats(rtts) {
    if (!rtts.length) return { min: null, avg: null, max: null, jitter: null };
    const min = Math.min(...rtts);
    const max = Math.max(...rtts);
    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    let jitter = 0;
    for (let i = 1; i < rtts.length; i += 1) jitter += Math.abs(rtts[i] - rtts[i - 1]);
    if (rtts.length > 1) jitter /= rtts.length - 1;
    return { min, avg, max, jitter };
  }

  /** 采样 RTT / 丢包；job 被停止时抛 AbortError。 */
  async function sampleRtt(job, { count, gap, timeout, onSample }) {
    const rtts = [];
    let lost = 0;
    const startedAt = performance.now();
    for (let i = 0; i < count; i += 1) {
      if (job.abort.signal.aborted) throw stopError();
      let rtt = null;
      try {
        rtt = await pingOnce(timeout, job.abort.signal);
        rtts.push(rtt);
      } catch (error) {
        if (job.abort.signal.aborted) throw stopError();
        lost += 1;
      }
      if (typeof onSample === 'function') onSample({ i, rtt, lost, elapsed: performance.now() - startedAt });
      await sleep(gap);
    }
    return { rtts, lost, count, ...latencyStats(rtts) };
  }

  /** 一条并发下载流：流式读取只计数不落内存（500MB 也不会吃爆手机内存）。 */
  async function downloadStream(job, query, sid, idx, loaded, onFirstByte) {
    const res = await fetch(`${API}/net/download?${query}&sid=${sid}&s=${idx}&t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: job.abort.signal,
    });
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`);
    if (!res.body) throw new Error('浏览器不支持流式读取');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded[idx] += value.byteLength;
      if (onFirstByte && !onFirstByte.done) {
        onFirstByte.done = true;
        onFirstByte.at = performance.now();
      }
    }
  }

  async function serverStats(sids) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stats = await Promise.all(sids.map((sid) => jsonGet(`/net/stat?sid=${sid}`).catch(() => null)));
      const good = stats.filter((s) => s && s.bytes > 0 && s.ms > 0);
      if (good.length > 0) {
        return {
          bytes: good.reduce((a, s) => a + s.bytes, 0),
          ms: Math.max(...good.map((s) => s.ms)),
          complete: good.length === sids.length,
        };
      }
      await sleep(120);
    }
    return null;
  }

  /** 多流并发下载；返回 { bytes, ms, source }，数字优先用服务端计时。 */
  async function measureDownload(job, target) {
    const sids = Array.from({ length: STREAMS }, () => pid());
    const loaded = new Array(STREAMS).fill(0);
    const perStreamMb = Math.ceil(Math.max(1, target.seconds ? 1 : (target.mb || 100)) / STREAMS);
    const expected = target.seconds ? 0 : perStreamMb * STREAMS * 1048576;
    const query = target.seconds ? `seconds=${target.seconds}` : `mb=${perStreamMb}`;
    const firstByte = { done: false, at: 0 };
    const startedAt = performance.now();
    let lastT = startedAt;
    let lastB = 0;
    job.live = { cur: 0, avg: 0, peak: 0, bytes: 0 };
    job.samples = [];
    job.peak = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      const bytes = loaded.reduce((a, b) => a + b, 0);
      const elapsed = Math.max(1, now - (firstByte.at || startedAt));
      const cur = ((bytes - lastB) / 1048576) / (Math.max(1, now - lastT) / 1000);
      const avg = (bytes / 1048576) / (elapsed / 1000);
      job.live = { cur, avg, peak: Math.max(job.peak, avg), bytes };
      if (cur > job.peak) job.peak = cur;
      job.samples.push({ t: now - startedAt, v: cur });
      if (job.samples.length > 240) job.samples.shift();
      if (expected > 0) job.progress = 10 + Math.min(0.99, bytes / expected) * 38;
      else if (target.seconds) job.progress = 10 + Math.min(0.99, (now - startedAt) / (target.seconds * 1000)) * 38;
      lastT = now;
      lastB = bytes;
    }, 180);
    try {
      await Promise.all(sids.map((sid, idx) => downloadStream(job, query, sid, idx, loaded, firstByte)));
    } finally {
      clearInterval(ticker);
    }
    const clientBytes = loaded.reduce((a, b) => a + b, 0);
    const clientMs = Math.max(1, performance.now() - (firstByte.at || startedAt));
    const stats = await serverStats(sids);
    if (stats) return { bytes: stats.bytes, ms: stats.ms, source: 'server', peak: job.peak };
    return { bytes: clientBytes, ms: clientMs, source: 'client', peak: job.peak };
  }

  function randomChunk(size = 65536) {
    const buf = new Uint8Array(size);
    crypto.getRandomValues(buf);
    return buf;
  }

  function buildBlob(mb) {
    const chunk = randomChunk(Math.min(65536, Math.max(1024, Math.round(mb * 1048576))));
    const count = Math.max(1, Math.ceil((mb * 1048576) / chunk.length));
    const parts = new Array(count).fill(chunk);
    return new Blob(parts);
  }

  async function measureUpload(job, mb) {
    const perStream = Math.max(1, Math.round(mb / STREAMS));
    const blobs = Array.from({ length: STREAMS }, () => buildBlob(perStream));
    const loaded = new Array(STREAMS).fill(0);
    const startedAt = performance.now();
    let lastT = startedAt;
    let lastB = 0;
    let firstAt = 0;
    job.live = { cur: 0, avg: 0, peak: 0, bytes: 0 };
    job.samples = [];
    job.peak = 0;
    const totalBytes = blobs.reduce((a, b) => a + b.size, 0);
    const ticker = setInterval(() => {
      const now = performance.now();
      const bytes = loaded.reduce((a, b) => a + b, 0);
      if (bytes > 0 && !firstAt) firstAt = now;
      const basis = Math.max(1, now - (firstAt || startedAt));
      const cur = ((bytes - lastB) / 1048576) / (Math.max(1, now - lastT) / 1000);
      const avg = (bytes / 1048576) / (basis / 1000);
      job.live = { cur, avg, peak: Math.max(job.peak, avg), bytes };
      if (cur > job.peak) job.peak = cur;
      job.samples.push({ t: now - startedAt, v: cur });
      if (job.samples.length > 240) job.samples.shift();
      job.progress = 55 + (bytes / Math.max(1, totalBytes)) * 38;
      lastT = now;
      lastB = bytes;
    }, 180);
    const jobs = blobs.map((blob, idx) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/net/upload?t=${Date.now()}-${idx}`, true);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.responseType = 'json';
      xhr.upload.onprogress = (event) => { loaded[idx] = event.loaded; };
      xhr.onload = () => resolve(xhr.response || {});
      xhr.onerror = () => reject(new Error('上传失败'));
      xhr.onabort = () => reject(stopError());
      job.abort.signal.addEventListener('abort', () => { try { xhr.abort(); } catch { /* 忽略 */ } }, { once: true });
      xhr.send(blob);
    }));
    try {
      const results = await Promise.all(jobs);
      const bytes = results.reduce((a, r) => a + (r && r.bytes ? r.bytes : 0), 0) || totalBytes;
      /* 修复（2026-11-06 审计 P1）：服务器没给计时数据时回退到真实客户端耗时，
         不再显示 Math.max(1,…) 造出的 1ms 假值；有服务器计时才标 'server' */
      const clientMs = Math.max(1, Math.round(performance.now() - startedAt));
      const serverMs = Math.max(0, ...results.map((r) => (r && r.transferMs ? r.transferMs : r && r.serverMs ? r.serverMs : 0)));
      return serverMs > 0
        ? { bytes, ms: Math.max(1, Math.round(serverMs)), source: 'server', peak: job.peak }
        : { bytes, ms: clientMs, source: 'client', peak: job.peak };
    } finally {
      clearInterval(ticker);
    }
  }

  /* ------------------------------------------------------------------ 体检结论 */

  function buildCheckItems(data, rtt, full) {
    const items = [];
    const scope = data && data.client ? data.client.scope : 'unknown';
    if (scope === 'lan') items.push({ key: 'link', level: OK, label: '连接方式', value: '局域网直连', hint: '手机和电脑在同一个网段' });
    else if (scope === 'loopback') items.push({ key: 'link', level: WARN, label: '连接方式', value: '本机回环', hint: '浏览器就在这台电脑上，带宽数字会虚高' });
    else if (scope === 'tailnet') items.push({ key: 'link', level: WARN, label: '连接方式', value: 'Tailscale 隧道', hint: '不是局域网直连，速度受隧道限制' });
    else if (scope === 'wan') items.push({ key: 'link', level: BAD, label: '连接方式', value: '外网 / 跨网段', hint: '可能经过代理或公网回源' });
    else items.push({ key: 'link', level: WARN, label: '连接方式', value: '未知', hint: '' });

    if (rtt.avg === null) {
      items.push({ key: 'rtt', level: BAD, label: '延迟', value: '全部超时', hint: '请求没回来' });
    } else if (rtt.avg < 10) items.push({ key: 'rtt', level: OK, label: '延迟', value: fmtMs(rtt.avg), hint: '内网正常水平（越小越好）' });
    else if (rtt.avg < 30) items.push({ key: 'rtt', level: WARN, label: '延迟', value: fmtMs(rtt.avg), hint: '偏高，可能是省电或链路繁忙' });
    else items.push({ key: 'rtt', level: BAD, label: '延迟', value: fmtMs(rtt.avg), hint: '很高，内网应低于 10ms' });

    if (rtt.jitter === null) items.push({ key: 'jitter', level: WARN, label: '抖动', value: '—', hint: '' });
    else if (rtt.jitter < 5) items.push({ key: 'jitter', level: OK, label: '抖动', value: fmtMs(rtt.jitter, 2), hint: '稳定' });
    else if (rtt.jitter < 15) items.push({ key: 'jitter', level: WARN, label: '抖动', value: fmtMs(rtt.jitter, 2), hint: '空口拥塞或省电策略' });
    else items.push({ key: 'jitter', level: BAD, label: '抖动', value: fmtMs(rtt.jitter, 2), hint: '链路不稳定' });

    const lossPct = rtt.count ? (rtt.lost / rtt.count) * 100 : 0;
    if (lossPct === 0) items.push({ key: 'loss', level: OK, label: '丢包', value: '0%', hint: '' });
    else if (lossPct <= 2) items.push({ key: 'loss', level: WARN, label: '丢包', value: `${lossPct.toFixed(0)}%`, hint: '' });
    else items.push({ key: 'loss', level: BAD, label: '丢包', value: `${lossPct.toFixed(0)}%`, hint: '信号或干扰问题' });

    const wlan = data && data.wlan;
    if (wlan && wlan.band) {
      const band2g = /2\.4/.test(String(wlan.band));
      const badSignal = wlan.rssi && wlan.rssi < -72;
      const level = band2g || badSignal ? WARN : OK;
      const value = `${wlan.band}${wlan.channel ? ` · ch${wlan.channel}` : ''}`;
      const hint = [wlan.rxMbps ? `${wlan.rxMbps} Mbps` : '', wlan.signal || '', wlan.rssi ? `${wlan.rssi} dBm` : ''].filter(Boolean).join(' · ');
      items.push({ key: 'wlan', level, label: 'Wi-Fi', value, hint: band2g ? '2.4G 上限低，建议改用 5G' : badSignal ? '信号偏弱，可离路由器近一点' : hint });
    } else {
      items.push({ key: 'wlan', level: OK, label: 'Wi-Fi', value: '有线 / 未使用', hint: '' });
    }

    if (full && data) {
      const gw = data.gateway;
      if (gw && gw.ping && gw.ping.lossPct === 0) items.push({ key: 'gw', level: OK, label: '到网关', value: `${gw.ping.avgMs ?? '—'} ms`, hint: gw.ip || '' });
      else if (gw && gw.ping) items.push({ key: 'gw', level: WARN, label: '到网关', value: `丢包 ${gw.ping.lossPct}%`, hint: gw.ip || '' });
      else items.push({ key: 'gw', level: WARN, label: '到网关', value: '测不到', hint: '' });

      const dns = data.dns;
      if (dns && dns.ok && dns.ms < 120) items.push({ key: 'dns', level: OK, label: 'DNS', value: `${dns.ms} ms`, hint: '' });
      else if (dns && dns.ok) items.push({ key: 'dns', level: WARN, label: 'DNS', value: `${dns.ms} ms`, hint: '解析偏慢' });
      else items.push({ key: 'dns', level: BAD, label: 'DNS', value: '失败', hint: '域名解析有问题' });

      const wan = data.wan;
      if (wan && wan.publicIp) items.push({ key: 'wan', level: OK, label: '公网出口', value: wan.publicIp, hint: wan.isp || '' });
      else items.push({ key: 'wan', level: WARN, label: '公网出口', value: '取不到', hint: '可能没有外网' });
    }
    return items;
  }

  function checkVerdict(items) {
    const level = worstLevel(items);
    const bads = items.filter((i) => i.level === BAD);
    const warns = items.filter((i) => i.level === WARN);
    const meta = verdictMeta(level);
    const focus = bads.length ? bads : warns;
    let note = '延迟、抖动、丢包和无线链路都在正常范围。';
    if (focus.length) {
      const parts = focus.slice(0, 2).map((i) => (i.hint ? `${i.label}（${i.hint}）` : i.label));
      note = `${bads.length ? '有异常：' : '稍有不足：'}${parts.join('；')}${bads.length ? '。' : '；其余正常。'}`;
    }
    return { ...meta, note, items };
  }

  function scopeShort(scope) {
    if (scope === 'lan') return '局域网';
    if (scope === 'loopback') return '本机';
    if (scope === 'tailnet') return '隧道';
    if (scope === 'wan') return '外网';
    return '未知';
  }

  /* ------------------------------------------------------------------ 后台任务 */

  function newJob(kind, opts) {
    return {
      id: pid(),
      kind,
      opts: opts || {},
      phase: '准备中',
      progress: 0,
      startedAt: Date.now(),
      samples: [],
      live: null,
      peak: 0,
      result: null,
      abort: new AbortController(),
    };
  }

  function startJob(kind, opts) {
    if (S.job) return false;
    const job = newJob(kind, opts);
    S.job = job;
    emit(true);
    const runner = kind === 'check' ? runCheckJob : kind === 'speed' ? runSpeedJob : runMonitorJob;
    Promise.resolve()
      .then(() => runner(job))
      .then((result) => finishJob(job, result))
      .catch((error) => failJob(job, error));
    return true;
  }

  function stopJob() {
    const job = S.job;
    if (!job) return;
    try { job.abort.abort(); } catch { /* 忽略 */ }
  }

  function finishJob(job, result) {
    if (S.job !== job) return;
    job.progress = 100;
    job.phase = '完成';
    job.result = result;
    S.job = null;

    const at = Date.now();
    if (job.kind === 'check') {
      S.check = { at, full: !!job.opts.full, auto: !!(job.opts.auto), data: result.data, rtt: result.rtt, items: result.items, verdict: result.verdict };
      history.unshift({
        id: job.id,
        kind: 'check',
        at,
        verdict: result.verdict.level,
        summary: `延迟 ${fmtMs(result.rtt.avg)} · 抖动 ${fmtMs(result.rtt.jitter, 2)} · 丢包 ${result.rtt.lossPct.toFixed(0)}%`,
        data: S.check,
      });
    } else if (job.kind === 'speed') {
      const entry = {
        id: job.id,
        kind: 'speed',
        at,
        down: result.down,
        up: result.up,
        rtt: result.rtt,
        lossPct: result.lossPct,
        peak: result.peak,
        opts: job.opts,
        verdict: result.verdict.level,
        summary: `下载 ${fmtMBps(result.down)} · 上传 ${fmtMBps(result.up)}`,
      };
      S.lastSpeed = entry;
      history.unshift(entry);
      toast(`测速完成：下载 ${fmtMBps(result.down)} · 上传 ${fmtMBps(result.up)}`);
    } else {
      const entry = {
        id: job.id,
        kind: 'monitor',
        at,
        seconds: job.opts.seconds,
        avg: result.avg,
        max: result.max,
        median: result.median,
        lossPct: result.lossPct,
        spikes: result.spikes.length,
        samples: result.samples.slice(-90),
        verdict: result.verdict.level,
        summary: `平均 ${fmtMs(result.avg)} · 最高 ${fmtMs(result.max)} · 丢包 ${result.lossPct.toFixed(1)}%`,
      };
      S.lastMonitor = entry;
      history.unshift(entry);
    }
    history.splice(MAX_HISTORY);
    persistHistory();

    if (!S.open) {
      const doneText = job.kind === 'speed'
        ? `测速完成：下载 ${fmtMBps(result.down)} · 上传 ${fmtMBps(result.up)}`
        : job.kind === 'check'
          ? `体检完成：${result.verdict.label}`
          : `监控完成：平均 ${fmtMs(result.avg)}`;
      toast(doneText, 3600);
    }
    emit(true);
  }

  function failJob(job, error) {
    if (S.job !== job) return;
    S.job = null;
    if (!isAbort(error)) {
      toast(`任务中断：${error && error.message ? error.message : error}`, 4000);
    } else {
      toast('已停止');
    }
    emit(true);
  }

  function jobProgress(job, phase, progress) {
    job.phase = phase;
    job.progress = progress;
    emit();
  }

  async function runCheckJob(job) {
    jobProgress(job, job.opts.full ? '读取网络与网关信息' : '读取网络信息', 5);
    let data = null;
    if (job.opts.full) {
      data = await jsonGet(`/net/diag?t=${Date.now()}-${pid()}`).catch(() => null);
      if (data) {
        S.status = { client: data.client, host: data.host, wlan: data.wlan, wan: data.wan, serverTime: data.serverTime };
        S.statusAt = Date.now();
      }
    } else {
      data = await ensureStatus(true);
    }
    if (job.abort.signal.aborted) throw stopError();
    jobProgress(job, '采样延迟 / 抖动 / 丢包', 35);
    const count = job.opts.full ? 15 : 8;
    const rtt = await sampleRtt(job, {
      count,
      gap: 90,
      timeout: 900,
      onSample: ({ i }) => { job.progress = 35 + ((i + 1) / count) * 55; emit(); },
    });
    jobProgress(job, '生成结论', 95);
    const lossPct = rtt.count ? (rtt.lost / rtt.count) * 100 : 0;
    const items = buildCheckItems(data, { ...rtt, lossPct }, !!job.opts.full);
    return { data, rtt: { ...rtt, lossPct }, items, verdict: checkVerdict(items) };
  }

  async function runSpeedJob(job) {
    const target = job.opts;
    jobProgress(job, '采样延迟', 3);
    const rtt = await sampleRtt(job, { count: 8, gap: 80, timeout: 900, onSample: ({ i }) => { job.progress = 3 + ((i + 1) / 8) * 5; emit(); } });
    jobProgress(job, '下载测试', 10);
    const down = await measureDownload(job, target.seconds ? { seconds: target.seconds } : { mb: target.downMb });
    if (job.abort.signal.aborted) throw stopError();
    jobProgress(job, '上传测试', 55);
    const up = await measureUpload(job, target.upMb);
    if (job.abort.signal.aborted) throw stopError();
    jobProgress(job, '汇总', 97);
    const downSpeed = mbpsOf(down.bytes, down.ms);
    const upSpeed = mbpsOf(up.bytes, up.ms);
    const lossPct = rtt.count ? (rtt.lost / rtt.count) * 100 : 0;
    const items = [];
    const scope = S.status ? S.status.client : null;
    if (scope && scope.scope === 'loopback') items.push({ level: WARN, label: '本机回环', value: '' });
    else if (scope && scope.scope !== 'lan' && scope.scope !== 'unknown') items.push({ level: WARN, label: '非局域网', value: '' });
    if (downSpeed !== null) items.push({ level: downSpeed >= 50 ? OK : downSpeed >= 20 ? WARN : BAD, label: '下载', value: '' });
    if (upSpeed !== null) items.push({ level: upSpeed >= 20 ? OK : upSpeed >= 8 ? WARN : BAD, label: '上传', value: '' });
    return {
      down: downSpeed,
      up: upSpeed,
      downBytes: down.bytes,
      downMs: down.ms,
      upBytes: up.bytes,
      upMs: up.ms,
      downSource: down.source,
      upSource: up.source,
      rtt: { avg: rtt.avg, min: rtt.min, max: rtt.max, jitter: rtt.jitter },
      lossPct,
      peak: down.peak || job.peak,
      samples: job.samples.slice(-160),
      verdict: verdictMeta(worstLevel(items.length ? items : [{ level: OK }])),
      items,
    };
  }

  async function runMonitorJob(job) {
    const seconds = Number(job.opts.seconds) || 60;
    const startedAt = Date.now();
    const samples = [];
    let lost = 0;
    job.live = { cur: 0, avg: 0, peak: 0, lost: 0 };
    jobProgress(job, `监控中（${seconds} 秒）`, 0);
    while (!job.abort.signal.aborted) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed >= seconds) break;
      let rtt = null;
      try {
        rtt = await pingOnce(1500, job.abort.signal);
      } catch (error) {
        if (job.abort.signal.aborted) throw stopError();
        lost += 1;
      }
      samples.push({ t: Number(elapsed.toFixed(2)), v: rtt });
      const good = samples.filter((s) => s.v !== null).map((s) => s.v);
      job.live = {
        cur: rtt || 0,
        avg: good.length ? good.reduce((a, b) => a + b, 0) / good.length : null,
        peak: good.length ? Math.max(...good) : null,
        lost,
      };
      job.samples = samples.slice(-240);
      job.progress = Math.min(99, (elapsed / seconds) * 100);
      emit();
      await sleep(280);
    }
    const good = samples.filter((s) => s.v !== null).map((s) => s.v);
    const avg = good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
    const max = good.length ? Math.max(...good) : null;
    const lossPct = samples.length ? (lost / samples.length) * 100 : 0;
    const sorted = [...good].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const spikes = samples.filter((s) => s.v === null || (median !== null && s.v > Math.max(80, median * 2.2)));
    const items = [];
    if (avg === null) items.push({ level: BAD });
    else if (avg < 15) items.push({ level: OK });
    else if (avg < 40) items.push({ level: WARN });
    else items.push({ level: BAD });
    if (lossPct > 2) items.push({ level: BAD });
    else if (lossPct > 0) items.push({ level: WARN });
    if (spikes.length > Math.max(3, samples.length * 0.1)) items.push({ level: WARN });
    return { samples, avg, max, lossPct, spikes, median, verdict: verdictMeta(worstLevel(items)) };
  }

  /* ------------------------------------------------------------------ 自动巡检 */

  let patrolTimer = 0;

  function schedulePatrol(delay) {
    clearTimeout(patrolTimer);
    if (!prefs.patrolEnabled) return;
    patrolTimer = Number(setTimeout(runPatrol, delay || prefs.patrolMinutes * 60000));
  }

  function patrolSummary() {
    const p = S.patrol.last;
    if (!p) return '还没巡检过';
    const state = p.degraded ? '发现波动' : '正常';
    return `上次 ${clock(p.at)} · ${state}${p.avg !== null && p.avg !== undefined ? `（平均 ${p.avg.toFixed(0)} ms）` : ''}`;
  }

  async function runPatrol() {
    try {
      if (document.hidden || S.job) return;
      const rtts = [];
      let lost = 0;
      for (let i = 0; i < 3; i += 1) {
        try { rtts.push(await pingOnce(1200)); } catch { lost += 1; }
        await sleep(240);
      }
      const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
      const baseline = S.patrol.baseline;
      const degraded = lost > 0 || (avg !== null && baseline !== null && avg > Math.max(120, baseline * 2.2));
      S.patrol.last = { at: Date.now(), avg, lost, degraded };
      if (avg !== null) S.patrol.baseline = baseline === null ? avg : baseline * 0.8 + avg * 0.2;
      if (degraded) {
        S.patrol.alert = true;
        toast(`巡检：网络变差（${avg === null ? '请求全部超时' : `平均 ${avg.toFixed(0)} ms`}${lost ? `，丢包 ${lost}/3` : ''}）`, 4000);
      }
      emit(true);
    } finally {
      schedulePatrol();
    }
  }

  /* ------------------------------------------------------------------ 报告 */

  function suggestions() {
    const list = [];
    const check = S.check;
    if (check && Array.isArray(check.items)) {
      for (const item of check.items) {
        if (item.level === OK) continue;
        if (item.key === 'wlan') list.push(item.hint || '无线信号偏弱，可换 5GHz 或靠近路由器');
        else if (item.key === 'link') list.push(item.hint || '当前不是局域网直连');
        else if (item.key === 'rtt' || item.key === 'jitter') list.push('延迟/抖动偏高：留意后台下载、省电模式或 Wi-Fi 干扰');
        else if (item.key === 'loss') list.push('有丢包：检查 Wi-Fi 干扰、距离或路由器负载');
        else if (item.key === 'dns') list.push(item.hint || 'DNS 解析慢');
        else if (item.key === 'gw') list.push('到网关不稳定：优先排查无线链路');
      }
    }
    if (S.lastSpeed && S.lastSpeed.down !== null && S.lastSpeed.down < 20) list.push('下载速度偏低：确认手机连的是 5GHz、且没有走 VPN / Tailscale');
    return [...new Set(list)].slice(0, 4);
  }

  function buildReport() {
    const lines = ['DSH 工具箱 · 网络体检报告', `时间：${dateTime(Date.now())}`, ''];
    const st = S.status;
    if (st && st.client) {
      lines.push(`连接方式：${st.client.label || '未知'}${st.client.note ? `（${st.client.note}）` : ''}`);
      lines.push(`客户端 IP：${st.client.ip || '—'}    本机：${hostText(st)}`);
      if (st.wan && st.wan.publicIp) lines.push(`公网出口：${st.wan.publicIp}${st.wan.isp ? `（${st.wan.isp}）` : ''}`);
      if (st.wlan && st.wlan.band) lines.push(`无线链路：${wlanText(st.wlan)}`);
    }
    if (S.check) {
      const rtt = S.check.rtt || {};
      lines.push('', '— 体检 —');
      lines.push(`延迟：平均 ${fmtMs(rtt.avg)}（最小 ${fmtMs(rtt.min)} / 最大 ${fmtMs(rtt.max)}）`);
      lines.push(`抖动：${fmtMs(rtt.jitter, 2)}    丢包：${Number(rtt.lossPct || 0).toFixed(1)}%`);
      if (S.check.verdict) lines.push(`结论：${S.check.verdict.label}（${S.check.verdict.note}）`);
    }
    if (S.lastSpeed) {
      const s = S.lastSpeed;
      lines.push('', '— 测速 —');
      lines.push(`下载：${fmtMBps(s.down)}${fmtMbps(s.down) ? `（${fmtMbps(s.down)}）` : ''}`);
      lines.push(`上传：${fmtMBps(s.up)}${fmtMbps(s.up) ? `（${fmtMbps(s.up)}）` : ''}`);
      if (s.peak) lines.push(`下载峰值：${fmtMBps(s.peak)}`);
      if (s.rtt && s.rtt.avg !== null) lines.push(`测速时延迟：平均 ${fmtMs(s.rtt.avg)} · 抖动 ${fmtMs(s.rtt.jitter, 2)} · 丢包 ${Number(s.lossPct || 0).toFixed(0)}%`);
    }
    if (S.lastMonitor) {
      const m = S.lastMonitor;
      lines.push('', '— 质量监控 —');
      lines.push(`平均 ${fmtMs(m.avg)} · 最高 ${fmtMs(m.max)} · 丢包 ${Number(m.lossPct || 0).toFixed(1)}% · 卡顿 ${m.spikes} 次 / ${m.seconds} 秒`);
    }
    const sug = suggestions();
    if (sug.length) {
      lines.push('', '— 建议 —');
      sug.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    lines.push('', `工具箱 v${VERSION} · ${dateTime(Date.now())}`);
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败'); }
    area.remove();
  }

  /* ------------------------------------------------------------------ 面板骨架 */

  const refs = { root: null, panel: null, body: null, progress: null, toast: null, entry: null, dot: null, navObserver: null };
  let navObserver = null;
  let toastTimer = 0;

  const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M19 7h1M4 17h4M13 17h7"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';

  function buildShell() {
    const root = h('div', { id: 'dsh-toolbox-root' });

    const closeBtn = h('button', { class: 'tbx-iconbtn', type: 'button', 'aria-label': '关闭工具箱', title: '关闭', text: '×', onclick: close });
    const refreshBtn = h('button', {
      class: 'tbx-iconbtn',
      type: 'button',
      'aria-label': '刷新连接状态',
      title: '刷新',
      onclick: () => { ensureStatus(true); if (S.check && Date.now() - S.check.at > 60000) startJob('check', { full: false, auto: true }); },
    }, h('span', { class: 'tbx-refresh', html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>' }));

    const head = h('header', { class: 'tbx-hd' },
      h('div', { class: 'tbx-hd-main' },
        h('div', { class: 'tbx-hd-icon', html: ICON }),
        h('div', { class: 'tbx-hd-titles' },
          h('div', { class: 'tbx-hd-title', text: '工具箱' }),
          h('div', { class: 'tbx-hd-sub', id: 'tbx-hd-sub', text: '正在读取连接信息…' }),
        ),
      ),
      h('div', { class: 'tbx-hd-actions' },
        h('span', { class: 'tbx-pill', id: 'tbx-hd-pill', text: '读取中' }),
        refreshBtn,
        closeBtn,
      ),
    );

    const body = h('div', { class: 'tbx-body', id: 'tbx-body' });
    const foot = h('footer', { class: 'tbx-ft' },
      h('span', { text: `工具箱 v${VERSION}` }),
      h('span', { text: '结果只存在本机浏览器' }),
    );
    const panel = h('aside', { class: 'tbx-panel', role: 'dialog', 'aria-label': '工具箱', 'aria-modal': 'false' }, head, body, foot);

    const progress = h('div', { class: 'tbx-progress-top', 'aria-hidden': 'true' }, h('i'));
    const toastEl = h('div', { class: 'tbx-toast', role: 'status' });

    root.append(panel, progress, toastEl);
    document.body.append(root);
    refs.root = root;
    refs.panel = panel;
    refs.body = body;
    refs.progress = progress;
    refs.toast = toastEl;

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && S.open) close();
    });
    window.addEventListener('resize', () => { if (S.open) renderPanel(); });

    body.addEventListener('click', onBodyClick);
  }

  function onBodyClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (!target) return;
    const act = target.getAttribute('data-act');
    if (act === 'check') {
      if (!startJob('check', { full: target.getAttribute('data-full') !== '0' })) toast('已有任务在跑，先等它结束');
    } else if (act === 'stop') stopJob();
    else if (act === 'speed') startSpeed();
    else if (act === 'monitor') {
      if (!startJob('monitor', { seconds: prefs.monitorSec })) toast('已有任务在跑，先等它结束');
    } else if (act === 'preset') {
      prefs.preset = target.getAttribute('data-value');
      persistPrefs();
      renderPanel();
    } else if (act === 'custom-down') {
      prefs.customDown = Number(target.getAttribute('data-value')) || 100;
      persistPrefs();
      renderPanel();
    } else if (act === 'custom-up') {
      prefs.customUp = Number(target.getAttribute('data-value')) || 20;
      persistPrefs();
      renderPanel();
    } else if (act === 'custom-seconds') {
      prefs.customSeconds = Number(target.getAttribute('data-value')) || 0;
      persistPrefs();
      renderPanel();
    } else if (act === 'monitor-sec') {
      prefs.monitorSec = Number(target.getAttribute('data-value')) || 60;
      persistPrefs();
      renderPanel();
    } else if (act === 'copy-report') {
      copyText(buildReport()).then(() => toast('报告已复制到剪贴板')).catch(() => {});
    } else if (act === 'clear-history') {
      history.length = 0;
      S.lastSpeed = null;
      S.lastMonitor = null;
      S.check = null;
      persistHistory();
      renderPanel();
      toast('历史已清空');
    } else if (act === 'patrol-toggle') {
      prefs.patrolEnabled = !prefs.patrolEnabled;
      persistPrefs();
      schedulePatrol();
      renderPanel();
    } else if (act === 'patrol-interval') {
      prefs.patrolMinutes = Number(target.getAttribute('data-value')) || 5;
      persistPrefs();
      schedulePatrol();
      renderPanel();
    } else if (act === 'refresh') {
      ensureStatus(true);
    }
  }

  function startSpeed() {
    if (S.job) { toast('已有任务在跑，先等它结束'); return; }
    let opts;
    if (prefs.preset === 'custom') opts = { downMb: prefs.customDown, upMb: prefs.customUp, seconds: prefs.customSeconds };
    else {
      const p = SPEED_PRESETS[prefs.preset] || SPEED_PRESETS.standard;
      opts = { downMb: p.downMb, upMb: p.upMb, seconds: p.seconds };
    }
    startJob('speed', opts);
  }

  function sidebarToggleButton() {
    const buttons = document.querySelectorAll('button[aria-label]');
    for (const button of buttons) {
      const label = button.getAttribute('aria-label') || '';
      if (/收起侧边栏|打开侧边栏/.test(label)) return button;
    }
    return null;
  }

  /** true=侧栏展开，false=收起，null=找不到按钮。 */
  function sidebarExpanded() {
    const button = sidebarToggleButton();
    if (!button) return null;
    return /收起/.test(button.getAttribute('aria-label') || '');
  }

  let sidebarAutoCollapsed = false;

  /** 桌面端：打开面板时主页面往左让位；窗口不够宽时顺手把左侧导航收成图标轨。 */
  function reserveSpace() {
    const frame = document.querySelector('[class*="_frame"]');
    if (!frame) return;
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const wide = !coarse && window.innerWidth >= RESERVE_MIN_VIEW;
    const width = panelWidth();
    const want = S.open && wide;
    const applied = frame.dataset.tbxReserved !== undefined;
    if (want) {
      if (!applied) {
        frame.dataset.tbxReserved = frame.style.paddingRight || '__none__';
        frame.dataset.tbxBoxSizing = frame.style.boxSizing || '';
        frame.style.transition = 'padding-right 0.24s cubic-bezier(0.22, 0.61, 0.36, 1)';
        const expanded = sidebarExpanded();
        if (expanded === true && window.innerWidth - width - 280 < 640) {
          const button = sidebarToggleButton();
          if (button) {
            button.click();
            sidebarAutoCollapsed = true;
          }
        }
      }
      if (frame.style.paddingRight !== width + 'px') {
        frame.style.boxSizing = 'border-box';
        frame.style.paddingRight = width + 'px';
      }
      if (refs.root) refs.root.style.setProperty('--tbx-panel-w', width + 'px');
    } else if (applied) {
      const previous = frame.dataset.tbxReserved;
      frame.style.paddingRight = previous === '__none__' ? '' : previous;
      frame.style.boxSizing = frame.dataset.tbxBoxSizing || '';
      frame.style.transition = '';
      delete frame.dataset.tbxReserved;
      delete frame.dataset.tbxBoxSizing;
      if (refs.root) refs.root.style.removeProperty('--tbx-panel-w');
      if (sidebarAutoCollapsed) {
        sidebarAutoCollapsed = false;
        if (sidebarExpanded() === false) {
          const button = sidebarToggleButton();
          if (button) button.click();
        }
      }
    }
  }
  function open() {
    if (!refs.root) return;
    S.open = true;
    refs.root.setAttribute('data-open', '1');
    reserveSpace();
    renderPanel();
    refreshEntry();
    updateProgress();
    ensureStatus(false);
    if (!S.job && (!S.check || Date.now() - (S.check.at || 0) > 120000)) startJob('check', { full: false, auto: true });
  }

  function close() {
    if (!refs.root) return;
    S.open = false;
    refs.root.removeAttribute('data-open');
    reserveSpace();
    if (S.job) toast('已转到后台继续运行：入口小圆点和顶部进度条会显示状态');
    refreshEntry();
    updateProgress();
  }

  function toggle() { if (S.open) close(); else open(); }

  /* ------------------------------------------------------------------ 渲染 */

  function hostText(status) {
    const addrs = (status && status.host && status.host.addresses) || [];
    const pick = addrs.find((a) => a.address.startsWith('192.168.')) || addrs.find((a) => a.address.startsWith('10.')) || addrs[0];
    return pick ? `${pick.address}${pick.iface ? `（${pick.iface}）` : ''}` : '—';
  }

  function wlanText(wlan) {
    if (!wlan || wlan.error || (!wlan.band && !wlan.radio)) return '非无线 / 取不到';
    return [wlan.band, wlan.channel ? `ch${wlan.channel}` : '', wlan.radio, wlan.rxMbps ? `${wlan.rxMbps} Mbps` : '', wlan.signal, wlan.rssi ? `${wlan.rssi} dBm` : ''].filter(Boolean).join(' · ');
  }

  function pillOf(scope, label) {
    const cls = scope === 'lan' ? 'lan' : scope === 'loopback' ? 'loopback' : scope === 'tailnet' || scope === 'wan' ? 'wan' : 'unknown';
    return h('span', { class: 'tbx-pill', dataset: { scope: cls }, text: label || '未知' });
  }

  function secHead(title, hint, ...actions) {
    return h('div', { class: 'tbx-sechd' },
      h('h3', { text: title }),
      hint ? h('span', { class: 'tbx-hint', text: hint }) : null,
      actions.length ? h('span', { class: 'tbx-sechd-actions' }, actions) : null,
    );
  }

  function progBar(job) {
    return h('div', { class: 'tbx-prog', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(2, Math.min(100, job.progress || 0))}%` }));
  }

  function jobLine(job) {
    return h('div', { class: 'tbx-jobline' },
      h('span', { class: 'tbx-spin', 'aria-hidden': 'true' }),
      h('span', { class: 'tbx-jobline-txt', text: `${job.phase}${job.progress > 0 ? ` · ${Math.round(job.progress)}%` : ''}` }),
      h('button', { class: 'tbx-btn tbx-btn--danger tbx-btn--sm', type: 'button', 'data-act': 'stop', text: '停止' }),
    );
  }

  function metric(label, value, sub, extra) {
    return h('div', { class: `tbx-metric${extra ? ` ${extra}` : ''}` },
      h('div', { class: 'l', text: label }),
      h('div', { class: 'v', text: value }),
      sub ? h('div', { class: 's', text: sub }) : null,
    );
  }

  function renderOverview() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('连接状态', S.statusLoading ? '刷新中…' : S.statusAt ? `更新于 ${clockSec(S.statusAt)}` : ''));
    if (!S.status) {
      sec.append(h('div', { class: 'tbx-empty', text: S.statusError ? `读取失败：${S.statusError}` : '正在读取网络信息…' }));
      return sec;
    }
    const st = S.status;
    const c = st.client || {};
    const kv = h('div', { class: 'tbx-kv' });
    const row = (label, value, extra) => {
      kv.append(h('div', { class: 'tbx-kvrow' },
        h('span', { class: 'tbx-k', text: label }),
        h('span', { class: 'tbx-v' }, ...(Array.isArray(value) ? value : [value])),
        extra || null,
      ));
    };
    row('连接方式', [pillOf(c.scope, c.label), c.note ? h('span', { class: 'tbx-note', text: c.note }) : null]);
    row('客户端 IP', c.ip || '—');
    row('本机地址', hostText(st));
    row('公网出口', st.wan && st.wan.publicIp ? `${st.wan.publicIp}${st.wan.isp ? `（${st.wan.isp}）` : ''}` : '取不到');
    row('无线链路', wlanText(st.wlan));
    if (st.host && st.host.hostname) row('电脑', `${st.host.hostname} · 运行 ${Math.floor((st.host.uptimeSec || 0) / 3600)} 小时`);
    sec.append(kv);
    return sec;
  }

  function renderCheck() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('一键体检', '约 3~5 秒 · 低流量'));
    const job = S.job && S.job.kind === 'check' ? S.job : null;
    if (job) {
      sec.append(h('div', { class: 'tbx-card' },
        jobLine(job),
        progBar(job),
        h('div', { class: 'tbx-note', text: job.opts.full ? '正在检查延迟、丢包、Wi-Fi、网关和 DNS…' : '正在自动做轻量检查（延迟 / 抖动 / 丢包）…' }),
      ));
    }
    const check = S.check;
    if (check) {
      const verdict = check.verdict || { level: OK, label: '良好', note: '' };
      sec.append(h('div', { class: 'tbx-verdict', dataset: { level: verdict.level } },
        h('div', { class: 'tbx-verdict-ico', html: verdict.level === OK ? '✓' : verdict.level === WARN ? '!' : '✕' }),
        h('div', { class: 'tbx-verdict-txt' },
          h('b', { text: `结论：${verdict.label}` }),
          h('p', { text: verdict.note || '' }),
        ),
      ));
      const rtt = check.rtt || {};
      const items = check.items || [];
      const wifi = items.find((i) => i.key === 'wlan');
      const gw = items.find((i) => i.key === 'gw');
      const dns = items.find((i) => i.key === 'dns');
      const grid = h('div', { class: 'tbx-metrics' },
        metric('延迟（平均）', fmtMs(rtt.avg), rtt.min !== null && rtt.min !== undefined ? `最小 ${fmtMs(rtt.min)} · 最大 ${fmtMs(rtt.max)}` : '越小越好'),
        metric('抖动', fmtMs(rtt.jitter, 2), '越小越稳'),
        metric('丢包', `${Number(rtt.lossPct || 0).toFixed(0)}%`, `${rtt.lost || 0} / ${rtt.count || 0} 次超时`),
        metric('Wi-Fi', wifi ? wifi.value : '—', wifi ? clampText(wifi.hint || '', 40) : ''),
      );
      sec.append(grid);
      const detail = h('details', { class: 'tbx-details' },
        h('summary', { text: '检查明细' }),
        h('div', { class: 'tbx-detail-list' },
          ...items.map((item) => h('div', { class: 'tbx-detail-row', dataset: { level: item.level } },
            h('span', { class: 'tbx-detail-dot' }),
            h('span', { class: 'tbx-detail-label', text: item.label }),
            h('span', { class: 'tbx-detail-value', text: item.value }),
            item.hint ? h('span', { class: 'tbx-detail-hint', text: item.hint }) : null,
          )),
        ),
      );
      sec.append(detail);
      const hint = check.full ? '完整体检' : '轻量检查';
      sec.append(h('div', { class: 'tbx-row-actions' },
        h('button', { class: 'tbx-btn tbx-btn--ghost', type: 'button', 'data-act': 'check', text: '重新体检（含网关/DNS）' }),
        h('span', { class: 'tbx-hint', text: `${hint} · ${clock(check.at)}${gw ? ` · 网关 ${gw.value}` : ''}${dns ? ` · DNS ${dns.value}` : ''}` }),
      ));
    } else if (!job) {
      sec.append(h('div', { class: 'tbx-empty', text: '打开面板会自动做一次轻量检查；点下面按钮可做完整检查（含网关和 DNS）。' }));
      sec.append(h('button', { class: 'tbx-btn', type: 'button', 'data-act': 'check', text: '立即体检' }));
    }
    return sec;
  }

  function renderSpeed() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('测速', '手机 ↔ 本机 · 数字以电脑侧计时为准'));
    const seg = h('div', { class: 'tbx-seg', role: 'tablist' },
      ...Object.entries(SPEED_PRESETS).map(([key, p]) => h('button', {
        type: 'button', role: 'tab', 'data-act': 'preset', 'data-value': key,
        'data-on': String(prefs.preset === key), title: `${p.hint} · 下载 ${p.downMb}MB / 上传 ${p.upMb}MB`,
        text: p.label,
      })),
      h('button', {
        type: 'button', role: 'tab', 'data-act': 'preset', 'data-value': 'custom',
        'data-on': String(prefs.preset === 'custom'), text: '自定义',
      }),
    );
    sec.append(seg);
    if (prefs.preset === 'custom') {
      sec.append(h('div', { class: 'tbx-custom' },
        h('div', { class: 'tbx-custom-row' }, h('span', { class: 'tbx-k', text: '下载' }), h('div', { class: 'tbx-chips' }, ...DOWN_CHOICES.map((v) => h('button', { class: 'tbx-chip', type: 'button', 'data-act': 'custom-down', 'data-value': v, 'data-on': String(prefs.customDown === v), text: `${v} MB` })))),
        h('div', { class: 'tbx-custom-row' }, h('span', { class: 'tbx-k', text: '上传' }), h('div', { class: 'tbx-chips' }, ...UP_CHOICES.map((v) => h('button', { class: 'tbx-chip', type: 'button', 'data-act': 'custom-up', 'data-value': v, 'data-on': String(prefs.customUp === v), text: `${v} MB` })))),
        h('div', { class: 'tbx-custom-row' }, h('span', { class: 'tbx-k', text: '时长' }), h('div', { class: 'tbx-chips' }, ...[0, 10, 30].map((v) => h('button', { class: 'tbx-chip', type: 'button', 'data-act': 'custom-seconds', 'data-value': v, 'data-on': String(prefs.customSeconds === v), text: v === 0 ? '按数据量' : `${v} 秒` })))),
      ));
    }
    const job = S.job && S.job.kind === 'speed' ? S.job : null;
    if (job) {
      const live = job.live || { cur: 0, avg: 0, peak: 0 };
      sec.append(h('div', { class: 'tbx-live' },
        h('div', { class: 'tbx-live-num' }, h('b', { text: (live.cur || 0).toFixed(2) }), h('span', { class: 'tbx-live-unit', text: 'MB/s 当前' })),
        h('div', { class: 'tbx-live-sub', text: `平均 ${(live.avg || 0).toFixed(2)} · 峰值 ${(live.peak || 0).toFixed(2)} MB/s · ${STREAMS} 并发流` }),
        progBar(job),
        h('div', { class: 'tbx-jobline' },
          h('span', { class: 'tbx-spin', 'aria-hidden': 'true' }),
          h('span', { class: 'tbx-jobline-txt', text: `${job.phase}${job.progress ? ` · ${Math.round(job.progress)}%` : ''}` }),
          h('button', { class: 'tbx-btn tbx-btn--danger tbx-btn--sm', type: 'button', 'data-act': 'stop', text: '停止' }),
        ),
      ));
      if (job.samples && job.samples.length > 1) sec.append(chartWrap(job.samples, job.peak));
      sec.append(h('div', { class: 'tbx-note', text: '关掉面板也会继续测，入口会显示进度；电脑和手机之间请别同时下载大文件。' }));
      return sec;
    }
    const last = S.lastSpeed;
    if (last) {
      const prev = history.find((e) => e.kind === 'speed' && e.id !== last.id);
      const delta = prev && prev.down && last.down ? ((last.down - prev.down) / prev.down) * 100 : null;
      sec.append(h('div', { class: 'tbx-metrics' },
        metric('下载（手机←电脑）', fmtMBps(last.down), fmtMbps(last.down) || '—', 'tbx-metric--hero'),
        metric('上传（手机→电脑）', fmtMBps(last.up), fmtMbps(last.up) || '—', 'tbx-metric--hero'),
        metric('测速时延迟', fmtMs(last.rtt && last.rtt.avg), last.rtt ? `抖动 ${fmtMs(last.rtt.jitter, 2)}` : ''),
        metric('下载峰值', fmtMBps(last.peak), `${clock(last.at)} 测的`),
      ));
      const bits = [];
      if (delta !== null) bits.push(`下载比上次${delta >= 0 ? '快' : '慢'} ${Math.abs(delta).toFixed(0)}%`);
      if (last.lossPct) bits.push(`丢包 ${Number(last.lossPct).toFixed(0)}%`);
      sec.append(h('div', { class: 'tbx-row-actions' },
        h('span', { class: 'tbx-hint', text: bits.join(' · ') || '' }),
        h('button', { class: 'tbx-btn tbx-btn--ghost tbx-btn--sm', type: 'button', 'data-act': 'copy-report', text: '复制报告' }),
      ));
    } else {
      sec.append(h('div', { class: 'tbx-empty', text: '选一个档位直接开始。数字由电脑侧计时，手机浏览器只负责收包和画曲线。' }));
    }
    if (!job) sec.append(h('button', { class: 'tbx-btn', type: 'button', 'data-act': 'speed', text: `开始测速（${presetDesc()}）` }));
    return sec;
  }

  function presetDesc() {
    if (prefs.preset === 'custom') {
      const sec = prefs.customSeconds ? `持续 ${prefs.customSeconds} 秒` : `下载 ${prefs.customDown}MB`;
      return `${sec} / 上传 ${prefs.customUp}MB`;
    }
    const p = SPEED_PRESETS[prefs.preset] || SPEED_PRESETS.standard;
    return p.seconds ? `持续 ${p.seconds} 秒 / 上传 ${p.upMb}MB` : `下载 ${p.downMb}MB / 上传 ${p.upMb}MB`;
  }

  function chartWrap(samples, peak) {
    const canvas = h('canvas', { class: 'tbx-chart' });
    const wrap = h('div', { class: 'tbx-chartwrap' }, canvas);
    requestAnimationFrame(() => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(2, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== height) { canvas.width = w; canvas.height = height; }
      ctx.clearRect(0, 0, w, height);
      const maxV = Math.max(peak || 0, 0.5, ...samples.map((s) => s.v || 0));
      const pad = 2 * dpr;
      const xs = (i) => (samples.length === 1 ? w : pad + (i / (samples.length - 1)) * (w - pad * 2));
      const ys = (v) => height - pad - (Math.min(Math.max(v || 0, 0), maxV) / maxV) * (height - pad * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = Math.max(1, dpr * 0.8);
      for (let i = 1; i <= 3; i += 1) {
        const y = Math.round((height * i) / 4);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, 'rgba(91,140,255,0.30)');
      grad.addColorStop(1, 'rgba(91,140,255,0.02)');
      ctx.beginPath();
      ctx.moveTo(xs(0), ys(samples[0] && samples[0].v));
      for (let i = 1; i < samples.length; i += 1) ctx.lineTo(xs(i), ys(samples[i].v));
      ctx.lineTo(xs(samples.length - 1), height - pad);
      ctx.lineTo(xs(0), height - pad);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < samples.length; i += 1) {
        const x = xs(i); const y = ys(samples[i].v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#6f9bff';
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = 'round';
      ctx.stroke();
    });
    return wrap;
  }

  function renderMonitor() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('质量监控', '后台跑 · 每 0.3 秒一个小请求', h('span', { class: 'tbx-hint', text: '查卡顿' })));
    const job = S.job && S.job.kind === 'monitor' ? S.job : null;
    const seg = h('div', { class: 'tbx-seg' },
      ...MONITOR_CHOICES.map((v) => h('button', { type: 'button', 'data-act': 'monitor-sec', 'data-value': v, 'data-on': String(Number(prefs.monitorSec) === v), text: v >= 60 ? `${v / 60} 分钟` : `${v} 秒` })),
    );
    sec.append(seg);
    if (job) {
      const live = job.live || {};
      sec.append(h('div', { class: 'tbx-live' },
        h('div', { class: 'tbx-live-num' }, h('b', { text: live.cur ? live.cur.toFixed(0) : '—' }), h('span', { class: 'tbx-live-unit', text: 'ms 当前' })),
        h('div', { class: 'tbx-live-sub', text: `平均 ${live.avg ? live.avg.toFixed(1) : '—'} ms · 最高 ${live.peak ? live.peak.toFixed(0) : '—'} ms · 丢包 ${live.lost || 0} 次` }),
        progBar(job),
        h('div', { class: 'tbx-jobline' },
          h('span', { class: 'tbx-spin', 'aria-hidden': 'true' }),
          h('span', { class: 'tbx-jobline-txt', text: `${job.phase} · ${Math.round(job.progress)}%` }),
          h('button', { class: 'tbx-btn tbx-btn--danger tbx-btn--sm', type: 'button', 'data-act': 'stop', text: '停止' }),
        ),
      ));
      if (job.samples && job.samples.length > 1) sec.append(monitorChart(job.samples));
      return sec;
    }
    const last = S.lastMonitor;
    if (last) {
      sec.append(h('div', { class: 'tbx-metrics' },
        metric('平均延迟', fmtMs(last.avg), `${last.seconds} 秒采样`),
        metric('最高延迟', fmtMs(last.max), last.median ? `中位 ${fmtMs(last.median)}` : ''),
        metric('丢包', `${Number(last.lossPct || 0).toFixed(1)}%`, ''),
        metric('卡顿次数', `${last.spikes || 0} 次`, '超过中位数 2.2 倍'),
      ));
      if (last.samples && last.samples.length > 1) sec.append(monitorChart(last.samples));
      sec.append(h('div', { class: 'tbx-row-actions' },
        h('span', { class: 'tbx-hint', text: `${clock(last.at)} 测的` }),
        h('button', { class: 'tbx-btn tbx-btn--ghost tbx-btn--sm', type: 'button', 'data-act': 'copy-report', text: '写进报告' }),
      ));
    } else {
      sec.append(h('div', { class: 'tbx-empty', text: '给你一段时间的延迟曲线：看的是「卡顿」，不是带宽。页面开着就能跑，随时可以关面板。' }));
    }
    sec.append(h('button', { class: 'tbx-btn', type: 'button', 'data-act': 'monitor', text: `${last ? '再监控一次' : '开始监控'}（${Number(prefs.monitorSec) >= 60 ? `${Number(prefs.monitorSec) / 60} 分钟` : `${prefs.monitorSec} 秒`}）` }));
    return sec;
  }

  function monitorChart(samples) {
    const canvas = h('canvas', { class: 'tbx-chart tbx-chart--mini' });
    const wrap = h('div', { class: 'tbx-chartwrap' }, canvas);
    requestAnimationFrame(() => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(2, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== height) { canvas.width = w; canvas.height = height; }
      ctx.clearRect(0, 0, w, height);
      const values = samples.map((s) => (s.v === null ? null : s.v));
      const good = values.filter((v) => v !== null);
      const maxV = Math.max(40, ...good, 1);
      const pad = 2 * dpr;
      const n = values.length;
      const xs = (i) => (n === 1 ? w : pad + (i / (n - 1)) * (w - pad * 2));
      const ys = (v) => height - pad - (Math.min(v, maxV) / maxV) * (height - pad * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = Math.max(1, dpr * 0.8);
      for (let i = 1; i <= 3; i += 1) { const y = Math.round((height * i) / 4); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i += 1) {
        const v = values[i];
        if (v === null) {
          started = false;
          continue;
        }
        const x = xs(i); const y = ys(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#6f9bff';
      ctx.lineWidth = 1.6 * dpr;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fillStyle = '#f87171';
      for (let i = 0; i < n; i += 1) {
        const v = values[i];
        if (v === null || (good.length > 2 && v > Math.max(80, good.slice().sort((a, b) => a - b)[Math.floor(good.length / 2)] * 2.2))) {
          ctx.beginPath(); ctx.arc(xs(i), v === null ? height - pad - 3 * dpr : ys(v), 2.4 * dpr, 0, Math.PI * 2); ctx.fill();
        }
      }
    });
    return wrap;
  }

  function kindMeta(kind) {
    if (kind === 'speed') return { icon: '⇅', label: '测速' };
    if (kind === 'monitor') return { icon: '≈', label: '监控' };
    return { icon: '✓', label: '体检' };
  }

  function renderHistory() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('历史记录', `${history.length} 条`, h('button', { class: 'tbx-link', type: 'button', 'data-act': 'clear-history', text: '清空' })));
    if (!history.length) {
      sec.append(h('div', { class: 'tbx-empty', text: '跑一次体检/测速/监控后自动保存，只存在这台设备的浏览器里。' }));
      return sec;
    }
    const list = h('div', { class: 'tbx-hlist' });
    for (const entry of history.slice(0, 8)) {
      const meta = kindMeta(entry.kind);
      list.append(h('div', { class: 'tbx-hrow' },
        h('span', { class: 'tbx-hico', text: meta.icon, title: meta.label }),
        h('div', { class: 'tbx-hmid' },
          h('div', { class: 'tbx-hsum', text: entry.summary || '' }),
          h('div', { class: 'tbx-htime', text: `${meta.label} · ${clock(entry.at)}` }),
        ),
        h('span', { class: 'tbx-badge', dataset: { level: entry.verdict || OK }, text: verdictMeta(entry.verdict).label }),
      ));
    }
    sec.append(list);
    return sec;
  }

  function renderPatrol() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('自动巡检', prefs.patrolEnabled ? `每 ${prefs.patrolMinutes} 分钟` : '已关闭'));
    sec.append(h('div', { class: 'tbx-switchrow' },
      h('div', { class: 'tbx-switchrow-txt' },
        h('div', { class: 'tbx-switchrow-title', text: prefs.patrolEnabled ? '页面开着时定时探一下' : '已暂停巡检' }),
        h('div', { class: 'tbx-hint', text: patrolSummary() }),
      ),
      h('button', { class: 'tbx-switch', type: 'button', role: 'switch', 'aria-checked': String(prefs.patrolEnabled), 'data-act': 'patrol-toggle', 'data-on': String(prefs.patrolEnabled), title: prefs.patrolEnabled ? '关闭' : '开启' }),
    ));
    if (prefs.patrolEnabled) {
      sec.append(h('div', { class: 'tbx-inline' },
        h('span', { class: 'tbx-hint', text: '间隔' }),
        ...PATROL_CHOICES.map((v) => h('button', { class: 'tbx-chip tbx-chip--sm', type: 'button', 'data-act': 'patrol-interval', 'data-value': v, 'data-on': String(Number(prefs.patrolMinutes) === v), text: `${v} 分钟` })),
      ));
      if (S.patrol.alert) sec.append(h('div', { class: 'tbx-inline tbx-inline--warn' }, h('span', { text: '上次巡检发现了波动，入口已标红。' }), h('button', { class: 'tbx-link', type: 'button', 'data-act': 'monitor', text: '跑一次监控' })));
    }
    return sec;
  }

  function renderReport() {
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('分享 / 报告', '一段中文总结，可直接发人'));
    sec.append(h('div', { class: 'tbx-row-actions tbx-row-actions--top' },
      h('button', { class: 'tbx-btn tbx-btn--ghost', type: 'button', 'data-act': 'copy-report', text: '复制体检报告' }),
    ));
    return sec;
  }

  function renderExtras() {
    if (!S.extras.length) return null;
    const sec = h('section', { class: 'tbx-sec' });
    sec.append(secHead('更多工具', `${S.extras.length} 个`));
    for (const tool of S.extras) {
      if (!tool._node) {
        const node = h('div', { class: 'tbx-card' });
        try { tool.render(node); } catch (error) { node.append(h('div', { class: 'tbx-empty', text: `渲染失败：${error}` })); }
        tool._node = node;
      }
      sec.append(tool._node);
    }
    return sec;
  }

  function renderHeader() {
    const sub = document.getElementById('tbx-hd-sub');
    const pill = document.getElementById('tbx-hd-pill');
    if (pill) {
      const c = S.status && S.status.client;
      const job = S.job;
      if (job) {
        pill.textContent = job.kind === 'speed' ? `测速 ${Math.round(job.progress)}%` : job.kind === 'monitor' ? `监控 ${Math.round(job.progress)}%` : '体检中';
        pill.dataset.scope = 'running';
      } else {
        pill.textContent = c ? scopeShort(c.scope) : '未连接';
        pill.title = c ? c.label || '' : '';
        pill.dataset.scope = c ? c.scope || 'unknown' : 'unknown';
      }
    }
    if (sub) {
      const bits = [];
      if (S.statusAt) bits.push(`更新于 ${clockSec(S.statusAt)}`);
      if (S.job) bits.push(`${S.job.phase} ${Math.round(S.job.progress)}%`);
      sub.textContent = bits.join(' · ') || '正在读取连接信息…';
    }
  }

  function renderPanel() {
    if (!refs.body) return;
    reserveSpace();
    const scrollTop = refs.body.scrollTop;
    renderHeader();
    const frag = document.createDocumentFragment();
    frag.append(renderOverview(), renderCheck(), renderSpeed(), renderMonitor(), renderHistory(), renderPatrol(), renderReport());
    const extras = renderExtras();
    if (extras) frag.append(extras);
    refs.body.replaceChildren(frag);
    refs.body.scrollTop = scrollTop;
  }

  /* ------------------------------------------------------------------ 入口 / 进度条 / toast */

  function refreshEntry() {
    if (!refs.entry) return;
    const nav = refs.entry.parentElement;
    const collapsed = sidebarExpanded() === false || !!nav && nav.getBoundingClientRect().width < 100;
    refs.entry.dataset.collapsed = collapsed ? '1' : '0';
    const dot = refs.dot;
    if (!dot) return;
    let state = 'idle';
    if (S.job) state = 'running';
    else if (S.patrol.alert) state = 'alert';
    dot.dataset.state = state;
    const tip = S.job ? `工具箱（${S.job.kind === 'speed' ? '测速' : S.job.kind === 'monitor' ? '监控' : '体检'}中 ${Math.round(S.job.progress)}%）` : S.patrol.alert ? '工具箱（巡检发现网络波动）' : '工具箱';
    refs.entry.title = tip;
    refs.entry.setAttribute('aria-label', tip);
  }

  function updateProgress() {
    const bar = refs.progress;
    if (!bar) return;
    const on = !!(S.job && !S.open);
    bar.setAttribute('data-on', on ? '1' : '0');
    if (on) bar.firstElementChild.style.width = `${Math.max(2, Math.min(100, S.job.progress || 0))}%`;
  }

  function toast(text, ms) {
    const el = refs.toast;
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-on', '1');
    S.toast = text;
    clearTimeout(toastTimer);
    toastTimer = Number(setTimeout(() => { el.removeAttribute('data-on'); S.toast = null; }, ms || 2600));
  }

  function mountEntry() {
    if (refs.entry && refs.entry.isConnected && document.getElementById('tbx-nav-entry')) return true;
    const nav = document.querySelector('nav[class*="panelList"]');
    if (!nav) return false;
    if (!refs.entry) {
      const dot = h('span', { class: 'tbx-navdot', dataset: { state: 'idle' } });
      const btn = h('button', { class: 'tbx-navrow', id: 'tbx-nav-entry', type: 'button', title: '工具箱', 'aria-label': '工具箱', html: `${ICON}<span>工具箱</span>` });
      btn.append(dot);
      btn.addEventListener('click', toggle);
      refs.entry = btn;
      refs.dot = dot;
    }
    nav.append(refs.entry);
    if (!refs.navObserver) {
      try {
        refs.navObserver = new ResizeObserver(() => refreshEntry());
        refs.navObserver.observe(nav);
      } catch { /* 忽略 */ }
    }
    refreshEntry();
    return true;
  }

  function watchNav() {
    if (navObserver) return;
    let lastCheck = 0;
    try {
      navObserver = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastCheck < 600) return;
        lastCheck = now;
        if (document.getElementById('tbx-nav-entry')) return;
        mountEntry();
      });
      navObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* 忽略 */ }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (mountEntry() || tries > 40) clearInterval(timer);
    }, 400);
  }

  /* ------------------------------------------------------------------ 公共 API / 启动 */

  function register(tool) {
    if (!tool || typeof tool.render !== 'function' || !tool.id) return false;
    if (S.extras.some((t) => t.id === tool.id)) return false;
    S.extras.push(tool);
    if (S.open) renderPanel();
    return true;
  }

  function boot() {
    if (document.getElementById('dsh-toolbox-root')) return;
    buildShell();
    watchNav();
    renderPanel();
    window.DSHToolbox = {
      register, open, close, toggle, version: VERSION, tools: S.extras,
      report: buildReport,
      debug: () => ({
        open: S.open,
        job: S.job ? { kind: S.job.kind, phase: S.job.phase, progress: Math.round(S.job.progress) } : null,
        check: S.check ? { at: S.check.at, full: S.check.full, verdict: S.check.verdict, rtt: S.check.rtt } : null,
        lastSpeed: S.lastSpeed,
        lastMonitor: S.lastMonitor,
        history: history.length,
        patrol: S.patrol,
        scope: S.status && S.status.client ? S.status.client.scope : null,
      }),
    };
    listeners.add(() => {
      refreshEntry();
      updateProgress();
      if (S.open) {
        renderHeader();
        renderPanel();
      }
    });
    // 首次启动：拿一次状态；巡检定时器挂在页面存活期。
    ensureStatus(false);
    if (prefs.patrolEnabled) schedulePatrol(20000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !prefs.patrolEnabled) return;
      const last = S.patrol.last;
      if (!last || Date.now() - last.at > (prefs.patrolMinutes * 60000) / 2) schedulePatrol(4000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
