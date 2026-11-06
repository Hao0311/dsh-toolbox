/**
 * dsh-toolbox — 注入式「工具箱」插件（宿主端）。
 *
 * 三件事：
 *   1. 通过官方 webserver/index-inject 把 client.css / client.js 内联进 index.html；
 *   2. 通过 ctx.connection.fetch.register 注册 /api/toolbox 下的测速路由；
 *   3. 提供 /api/toolbox/net/status：把「连接情况」汇总成一份 JSON
 *      （客户端来源分类 / 本机地址 / WLAN 频段·速率·信号 / 公网出口 IP）。
 *
 * apply 永不抛：插件坏了最坏是面板不出现，不会把整页 index.html 打挂。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import dns from 'node:dns';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = '/api/toolbox';

/** 1 MiB 随机块：随机数据不可压缩，避免任何中间层压缩把测速数字抬上去。 */
const CHUNK = 1 << 20;
const NOISE = randomBytes(CHUNK);

const MAX_MB = 4096;
const DEFAULT_MB = 50;
const MAX_UPLOAD_MB = 256;

/** 最近一次 /api 请求的来源地址（浏览器看不到这个，只能由宿主记录）。 */
const peer = { ip: '', port: 0, at: 0 };

/** 服务端侧计时结果：sid → { bytes, ms }（数字由电脑算，不依赖手机浏览器）。 */
const statStore = new Map();

function putStat(sid, value) {
  if (!sid) return;
  statStore.set(String(sid), { ...value, at: Date.now() });
  if (statStore.size > 64) {
    const now = Date.now();
    for (const [key, item] of statStore) {
      if (now - item.at > 120000) statStore.delete(key);
    }
  }
}

const fileCache = new Map();

function readFresh(name) {
  const path = join(HERE, name);
  const info = statSync(path);
  const hit = fileCache.get(path);
  if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.text;
  const text = readFileSync(path, 'utf8');
  fileCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text });
  return text;
}

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ 连接情况 */

let wlanCache = { at: 0, value: null };
let wanCache = { at: 0, value: null };

function decodeOut(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buf);
  } catch {
    return utf8;
  }
}

function run(cmd, args, timeout = 1800) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20, encoding: 'buffer' }, (error, stdout) => {
        resolve(error ? { ok: false, error: String(error.message ?? error), out: '' } : { ok: true, out: decodeOut(stdout) });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error), out: '' });
    }
  });
}

/** netsh wlan show interfaces → { ssid, band, channel, radio, rxMbps, txMbps, signal, rssi }
 *  注意：这台机器上 netsh 的界面语言会随调用上下文变化（PowerShell 里是英文、
 *  从 node 子进程里是中文），所以中英文标签都要认，冒号还要认全角。 */
function parseWlan(text) {
  const pick = (...labels) => {
    for (const label of labels) {
      // 允许标签后面跟 "(Mbps)" 这类括号单位，再跟半角/全角冒号
      const m = new RegExp(`^\\s*${label}\\s*(?:\\([^)]*\\))?\\s*[:：]\\s*(.+)$`, 'm').exec(text);
      if (m) return m[1].trim();
    }
    return '';
  };
  const band = pick('Band', '波段');
  const channel = pick('Channel', '通道', '信道');
  const radio = pick('Radio type', '无线电类型');
  const rx = pick('Receive rate \\(Mbps\\)', '接收速率');
  const tx = pick('Transmit rate \\(Mbps\\)', '传输速率');
  const signal = pick('Signal', '信号');
  const rssi = pick('Rssi');
  const ssid = pick('SSID');
  if (!radio && !band) return null;
  return {
    ssid,
    band,
    channel,
    radio,
    rxMbps: Number(rx) || null,
    txMbps: Number(tx) || null,
    signal,
    rssi: Number(rssi) || null,
  };
}

async function wlanInfo() {
  if (Date.now() - wlanCache.at < 8000) return wlanCache.value;
  const res = await run('netsh', ['wlan', 'show', 'interfaces']);
  const value = res.ok ? parseWlan(res.out) : { error: res.error };
  wlanCache = { at: Date.now(), value };
  return value;
}

/** 公网出口（3 秒超时，10 分钟缓存；失败返回 null，不影响其它字段）。
 *  国内环境 api.ipify.org 经常直接空响应，所以主用 myip.ipip.net（还能带运营商/归属地）。 */
async function wanInfo() {
  if (Date.now() - wanCache.at < 600000) return wanCache.value;
  const timeout = (ms) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  };
  let value = null;
  {
    const t = timeout(3000);
    try {
      const res = await fetch('https://myip.ipip.net', { signal: t.signal, cache: 'no-store' });
      const text = String(await res.text());
      const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
      if (m) {
        const where = text.replace(/当前\s*IP[:：]\s*\d{1,3}(?:\.\d{1,3}){3}/, '').replace(/来自于[:：]?/, '').trim();
        value = { publicIp: m[1], isp: where || '' };
      }
    } catch { /* 忽略 */ } finally { t.done(); }
  }
  if (value === null) {
    const t = timeout(2500);
    try {
      const res = await fetch('http://ip-api.com/json/?fields=query,isp,country', { signal: t.signal, cache: 'no-store' });
      const body = await res.json();
      if (body && body.query) value = { publicIp: String(body.query), isp: [body.country, body.isp].filter(Boolean).join(' ') };
    } catch { /* 忽略 */ } finally { t.done(); }
  }
  wanCache = { at: Date.now(), value };
  return value;
}

function ipv4Of() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function classify(clientIp, hostAddrs) {
  if (!clientIp) return { scope: 'unknown', label: '未知' };
  const ip = clientIp.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')) {
    return { scope: 'loopback', label: '本机回环', note: '浏览器就在这台电脑上' };
  }
  if (hostAddrs.some((a) => a.address === ip)) {
    return { scope: 'loopback', label: '本机（经局域网地址回来）', note: '仍是同一台电脑' };
  }
  if (ip.startsWith('100.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 64 && second <= 127) {
      return { scope: 'tailnet', label: 'Tailscale 隧道', note: '不是局域网直连，速度受隧道限制' };
    }
  }
  const sameSubnet = hostAddrs.some((a) => {
    if (!a.netmask) return false;
    const [c1, c2, c3, c4] = ip.split('.').map(Number);
    const [h1, h2, h3, h4] = a.address.split('.').map(Number);
    const [m1, m2, m3, m4] = a.netmask.split('.').map(Number);
    if ([c1, c2, c3, c4, h1, h2, h3, h4, m1, m2, m3, m4].some((v) => !Number.isFinite(v))) return false;
    const c = ((c1 << 24) | (c2 << 16) | (c3 << 8) | c4) >>> 0;
    const h = ((h1 << 24) | (h2 << 16) | (h3 << 8) | h4) >>> 0;
    const m = ((m1 << 24) | (m2 << 16) | (m3 << 8) | m4) >>> 0;
    return (c & m) === (h & m);
  });
  if (sameSubnet) return { scope: 'lan', label: '局域网直连', note: '同一网段，走路由器/AP' };
  return { scope: 'wan', label: '外网', note: '跨网段，可能经代理或公网回源' };
}

async function handleStatus() {
  const addrs = ipv4Of();
  const [wlan, wan] = await Promise.all([wlanInfo().catch(() => null), wanInfo().catch(() => null)]);
  return json(200, {
    ok: true,
    client: { ip: peer.ip, port: peer.port, seenAt: peer.at, ...classify(peer.ip, addrs) },
    host: { hostname: os.hostname(), addresses: addrs, platform: process.platform, uptimeSec: Math.round(os.uptime()) },
    wlan,
    wan: wan || { publicIp: null, isp: '' },
    serverTime: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ 测速路由 */

function noiseStream(total, sid) {
  let sent = 0;
  let startedAt = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        if (sid && startedAt > 0) putStat(sid, { bytes: total, ms: Date.now() - startedAt, kind: "download" });
        controller.close();
        return;
      }
      if (startedAt === 0) startedAt = Date.now();
      const n = Math.min(CHUNK, total - sent);
      sent += n;
      controller.enqueue(NOISE.slice(0, n));
    },
  });
}

/** 按时长持续发送（不限总字节，客户端读到流结束为止）——用于「实时」持续测速。 */
function timedNoiseStream(durationMs, sid) {
  const deadline = Date.now() + durationMs;
  let sent = 0;
  let startedAt = 0;
  return new ReadableStream({
    pull(controller) {
      if (Date.now() >= deadline) {
        if (sid && startedAt > 0) putStat(sid, { bytes: sent, ms: Date.now() - startedAt, kind: "download" });
        controller.close();
        return;
      }
      if (startedAt === 0) startedAt = Date.now();
      sent += CHUNK;
      controller.enqueue(NOISE.slice(0, CHUNK));
    },
  });
}

function handleDownload(request) {
  const url = new URL(request.url);
  const sid = url.searchParams.get('sid');
  const seconds = Number.parseFloat(String(url.searchParams.get('seconds') ?? ''));
  if (Number.isFinite(seconds) && seconds > 0) {
    const ms = Math.min(Math.max(seconds, 1), 120) * 1000;
    const headers = {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-dsh-toolbox-seconds': String(ms / 1000),
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(timedNoiseStream(ms, sid), { status: 200, headers });
  }
  const mb = intParam(url.searchParams.get('mb'), DEFAULT_MB, 1, MAX_MB);
  const total = mb * CHUNK;
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(total),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(noiseStream(total, sid), { status: 200, headers });
}

async function handleUpload(request) {
  const t0 = Date.now();
  const sid = new URL(request.url).searchParams.get('sid');
  const cap = MAX_UPLOAD_MB * CHUNK;
  let bytes = 0;
  let firstByteAt = 0;
  try {
    if (request.body !== null) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteAt === 0) firstByteAt = Date.now();
        bytes += value.byteLength;
        if (bytes > cap) {
          try { await reader.cancel(); } catch { /* 忽略 */ }
          return json(413, { ok: false, error: 'too large', bytes, limitMb: MAX_UPLOAD_MB });
        }
      }
    }
  } catch (error) {
    return json(400, { ok: false, error: String(error?.message ?? error) });
  }
  const end = Date.now();
  putStat(sid, { bytes, ms: firstByteAt > 0 ? end - firstByteAt : 0, kind: "upload" });
  return json(200, {
    ok: true,
    bytes,
    serverMs: end - t0,
    // 服务端侧计时：首字节→最后一字节，不依赖浏览器 performance.now()
    transferMs: firstByteAt > 0 ? end - firstByteAt : 0,
    sid: sid || null,
  });
}

function handleInfo(request) {
  const url = new URL(request.url);
  return json(200, {
    ok: true,
    ip: peer.ip,
    port: peer.port,
    at: peer.at,
    host: request.headers.get('host') ?? '',
    serverTime: new Date().toISOString(),
    pingToken: url.searchParams.get('t') ?? '',
  });
}


/* ------------------------------------------------------------------ 自检 */

function parsePing(text) {
  // 不依赖语言：丢包取括号里的百分比，时延取统计行里按 最小/最大/平均 顺序出现的 "= N ms"。
  const loss = /\((\d+)%/.exec(text);
  const all = [];
  const re = /=\s*(\d+)\s*ms/gi;
  let m;
  while ((m = re.exec(text)) !== null) all.push(Number(m[1]));
  const times = all.slice(-3); // 统计块在最后：最小/最大/平均 或 Minimum/Maximum/Average
  return {
    lossPct: loss ? Number(loss[1]) : null,
    minMs: times.length > 0 ? times[0] : null,
    maxMs: times.length > 1 ? times[1] : null,
    avgMs: times.length > 2 ? times[2] : null,
  };
}

async function findGateway() {
  const res = await run('route', ['print', '-4']);
  if (!res.ok) return '';
  const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})/m.exec(res.out);
  return m ? m[1] : '';
}

async function handleDiag() {
  const addrs = ipv4Of();
  const gateway = await findGateway().catch(() => '');
  const [wlan, wan] = await Promise.all([wlanInfo().catch(() => null), wanInfo().catch(() => null)]);

  let ping = null;
  if (gateway) {
    const res = await run('ping', ['-n', '4', '-w', '1000', gateway], 6000);
    if (res.ok) ping = parsePing(res.out);
  }

  const dnsStart = Date.now();
  let dnsOk = true;
  await new Promise((resolve) => {
    dns.lookup('www.baidu.com', (err) => { if (err) dnsOk = false; resolve(); });
  });
  const dnsMs = Date.now() - dnsStart;

  return json(200, {
    ok: true,
    client: { ip: peer.ip, ...classify(peer.ip, addrs) },
    host: { hostname: os.hostname(), addresses: addrs },
    gateway: { ip: gateway, ping },
    dns: { ok: dnsOk, ms: dnsMs },
    wlan,
    wan,
    load: { loadavg: os.loadavg(), cpus: os.cpus().length, freeMemMB: Math.round(os.freemem() / 1048576), totalMemMB: Math.round(os.totalmem() / 1048576) },
    uptimeSec: Math.round(os.uptime()),
    serverTime: new Date().toISOString(),
  });
}

const ROUTES = [
  { path: `${PREFIX}/net/download`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: handleDownload },
  { path: `${PREFIX}/net/upload`, methods: ['POST'], requestBody: 'streaming', fetch: handleUpload },
  { path: `${PREFIX}/net/info`, methods: ['GET'], requestBody: 'buffered', fetch: handleInfo },
  { path: `${PREFIX}/net/diag`, methods: ['GET'], requestBody: 'buffered', fetch: () => handleDiag() },
  { path: `${PREFIX}/net/stat`, methods: ['GET'], requestBody: 'buffered', fetch: (request) => json(200, statStore.get(String(new URL(request.url).searchParams.get('sid') || '')) ?? { pending: true }) },
  { path: `${PREFIX}/net/status`, methods: ['GET'], requestBody: 'buffered', fetch: () => handleStatus() },
];

function registerRoutes(ctx, state) {
  if (state.routes) return true;
  try {
    const fetcher = ctx.connection?.fetch;
    if (!fetcher || typeof fetcher.register !== 'function') {
      state.reason = 'connection.fetch not ready';
      return false;
    }
    for (const route of ROUTES) {
      ctx.effect(() => fetcher.register(route), `dsh-toolbox: ${route.path}`);
    }
    state.routes = true;
    state.reason = 'ok';
    try { ctx.logger?.info?.('dsh-toolbox: /api/toolbox 路由已注册'); } catch { /* 忽略 */ }
    return true;
  } catch (error) {
    state.reason = `register failed: ${error?.message ?? String(error)}`;
    try { ctx.logger?.warn?.(`dsh-toolbox: ${state.reason}`); } catch { /* 忽略 */ }
    return false;
  }
}

/** 记录来源地址。waterfall 事件，必须把 next() 继续传下去，否则 /api 整条链路会卡住。 */
function watchPeer(ctx) {
  try {
    ctx.on('connection/request', (req, res, next) => {
      try {
        peer.ip = req?.socket?.remoteAddress ?? '';
        peer.port = req?.socket?.remotePort ?? 0;
        peer.at = Date.now();
      } catch { /* 忽略 */ }
      return next();
    });
  } catch { /* 忽略 */ }
}

function apply(ctx) {
  const state = { routes: false, rows: 0, reason: 'not attempted' };
  watchPeer(ctx);
  try {
    ctx.on('webserver/index-inject', (table) => {
      try {
        const rows = [];
        try {
          rows.push({ kind: 'style', text: readFresh('client.css') });
        } catch (error) {
          state.reason = `css: ${error?.message ?? error}`;
        }
        try {
          rows.push({ kind: 'script', placement: 'head', text: readFresh('client.js') });
        } catch (error) {
          state.reason = `js: ${error?.message ?? error}`;
        }
        state.rows = rows.length;
        for (const row of rows) table.push(row);
        table.push({ kind: 'global', name: '__DSH_TOOLBOX__', value: { rows: state.rows, routes: state.routes, reason: state.reason } });
        registerRoutes(ctx, state);
      } catch (error) {
        state.reason = `inject failed: ${error?.message ?? String(error)}`;
      }
    }, { prepend: true });
  } catch (error) {
    state.reason = `ctx.on failed: ${error?.message ?? String(error)}`;
  }
  try {
    registerRoutes(ctx, state);
  } catch (error) {
    state.reason = `register (apply) threw: ${error?.message ?? String(error)}`;
  }
}

export { apply, handleDownload, handleUpload, handleInfo, handleStatus, handleDiag, parseWlan, classify, PREFIX, CHUNK };
export const inject = ['connection'];
apply.inject = ['connection'];
