// SpiderPanel — cfnew preferred-address engine (live Cloudflare edge pools)
// ══════════════════════════════════════════════════════════════════════════════
// Exact port of byJoey/cfnew's 优选 (preferred address) pipeline:
//   1. Custom preferred addresses (cfnew `yx` → our settings.cleanIps)
//   2. Preferred Cloudflare domains (cfnew 直连域名列表, flag epd)
//   3. Per-ISP preferred IPs from the uouin API (cfnew 获取值地址列表, flag epi)
//   4. Repo bestip list (cfnew 仓库优选 via yxURL, flag egi)
// Every candidate must pass a live TCP probe before it becomes a node, the
// probe window rotates every 20 minutes (cfnew's "always alive" behaviour),
// and results are cached in KV + isolate memory.
//
// Port classes mirror cfnew exactly:
//   TLS ports:      443, 2053, 2083, 2087, 2096, 8443 (Cloudflare HTTPS ports)
//   non-TLS ports:  80, 8080, 8880, 2052, 2082, 2086, 2095
// ══════════════════════════════════════════════════════════════════════════════

import { connect } from "cloudflare:sockets";

// cfnew 直连域名列表 — preferred Cloudflare-fronted domains (verbatim)
export const PREFERRED_DOMAINS = [
  { name: "cloudflare.182682.xyz", domain: "cloudflare.182682.xyz" },
  { name: "speed.marisalnc.com", domain: "speed.marisalnc.com" },
  { domain: "freeyx.cloudflare88.eu.org" },
  { domain: "bestcf.top" },
  { domain: "cdn.2020111.xyz" },
  { domain: "cfip.cfcdn.vip" },
  { domain: "cf.0sm.com" },
  { domain: "cf.090227.xyz" },
  { domain: "cf.zhetengsha.eu.org" },
  { domain: "cloudflare.9jy.cc" },
  { domain: "cf.zerone-cdn.pp.ua" },
  { domain: "cfip.1323123.xyz" },
  { domain: "cnamefuckxxs.yuchen.icu" },
  { domain: "cloudflare-ip.mofashi.ltd" },
  { domain: "115155.xyz" },
  { domain: "cname.xirancdn.us" },
  { domain: "f3058171cad.002404.xyz" },
  { domain: "8.889288.xyz" },
  { domain: "cdn.tzpro.xyz" },
  { domain: "cf.877771.xyz" },
  { domain: "xn--b6gac.eu.org" },
];

// cfnew snippets 仓库优选网址 — the repo bestip list cfnew ships by default.
export const DEFAULT_BESTIP_URL =
  "https://raw.githubusercontent.com/qwer-search/bestip/refs/heads/main/kejilandbestip.txt";

// ── uouin preferred-IP API (cfnew 获取值地址列表, key chain identical) ────────
const UOUIN_URL = "https://api.uouin.com/index.php/index/Cloudflare";
const UOUIN_SALT_INNER = "DdlTxtN0sUOu"; // cfnew: 解码64('RGRsVHh0TjBzVU91')
const UOUIN_SALT_KEY = "70cloudflareapikey"; // cfnew: 解码64('NzBjbG91ZGZsYXJlYXBpa2V5')
const UOUIN_GROUPS = { ctcc: "电信", cucc: "联通", cmcc: "移动", bgp: "多线", ipv6: "IPv6" };

// MD5 via WebCrypto (Workers) with a pure-JS fallback — cfnew relies on the
// Workers-only MD5 extension; the fallback keeps the uouin source alive in
// any runtime (e.g. local tooling).
function md5Pure(bytes) {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const len = bytes.length;
  const withPad = (((len + 8) >> 6) + 1) << 6;
  const m = new Uint8Array(withPad);
  m.set(bytes); m[len] = 0x80;
  const bits = len * 8;
  const lo = bits >>> 0;
  const hi = Math.floor(bits / 4294967296);
  for (let i = 0; i < 4; i++) {
    m[withPad - 8 + i] = (lo >>> (8 * i)) & 255;
    m[withPad - 4 + i] = (hi >>> (8 * i)) & 255;
  }
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = m[off + 4 * i] | (m[off + 4 * i + 1] << 8) | (m[off + 4 * i + 2] << 16) | (m[off + 4 * i + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[4 * i + j] = (words[i] >>> (8 * j)) & 255;
  return out;
}

async function md5Hex(text) {
  const bytes = new TextEncoder().encode(text);
  try {
    const buf = await crypto.subtle.digest("MD5", bytes);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Array.from(md5Pure(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

function normalizeHost(h) {
  return String(h || "").trim().replace(/^\[([^\]]+)\]$/, "$1");
}

export async function fetchUouinAddresses() {
  const ts = String(Date.now());
  const inner = await md5Hex(UOUIN_SALT_INNER);
  const key = await md5Hex(inner + UOUIN_SALT_KEY + ts);
  const res = await fetch(UOUIN_URL + "?key=" + key + "&time=" + ts, {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const groups = data && data.data;
  if (!groups) return [];
  const out = [];
  for (const g of Object.keys(UOUIN_GROUPS)) {
    const info = groups[g] && Array.isArray(groups[g].info) ? groups[g].info : [];
    for (const item of info) {
      const host = normalizeHost(item && item.ip);
      if (!host) continue;
      out.push({ host, port: 0, name: UOUIN_GROUPS[g] });
    }
  }
  return out;
}

// ── Repo bestip list parsing (cfnew 获取值解析新地址列表 + 获取优选接口) ─────
// Supports: `host:port#name` lines, bare hosts (default 443), and the CSV
// variant with Chinese headers (IP地址,端口[,国家/城市/数据中心[,TLS]]).
export async function fetchBestipList(url, timeoutMs = 8000) {
  url = String(url || "").trim();
  if (!url) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "SpiderPanel/1.0" } });
    if (!res.ok) return [];
    text = await res.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  // CSV mode (cfnew: first line contains commas and known headers)
  if (lines.length > 1 && lines[0].includes(",")) {
    const head = lines[0].split(",").map((h) => h.trim());
    const iAddr = head.indexOf("IP地址") >= 0 ? head.indexOf("IP地址") : head.findIndex((h) => h.includes("IP"));
    const iPort = head.indexOf("端口");
    if (iAddr >= 0 && iPort >= 0) {
      const iName = head.indexOf("国家") >= 0 ? head.indexOf("国家") : head.indexOf("城市") >= 0 ? head.indexOf("城市") : head.indexOf("数据中心");
      const iTls = head.indexOf("TLS");
      const out = [];
      for (const line of lines.slice(1)) {
        const cols = line.split(",").map((c) => c.trim());
        if (iTls >= 0 && String(cols[iTls] || "").toLowerCase() !== "true") continue;
        const host = normalizeHost(cols[iAddr]).replace(/^[^\[]*:[^\[\]]*:[^\[\]]/, (m) => "[" + m + "]");
        const port = parseInt(cols[iPort], 10) || 0;
        if (!host || !port) continue;
        out.push({ host: host.replace(/^\[|\]$/g, ""), port, name: iName >= 0 ? cols[iName] || "" : "" });
      }
      if (out.length) return out;
    }
  }

  // Line mode: host:port#name | host:port | host#name | host
  const re = /^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::(\d+))?(?:#(.+))?$/;
  const out = [];
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const host = normalizeHost(m[1]);
    if (!host) continue;
    out.push({
      host,
      port: m[2] ? parseInt(m[2], 10) : 0,
      name: m[3] ? m[3].trim() : host,
    });
  }
  return out;
}

// ── Naming (cfnew 获取值节点别名基础 / 处理值节点别名部分 / 创建值节点命名器) ──
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_RE = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^(?:[0-9a-fA-F]{1,4}:)*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$/;

export function isIpAddr(host) {
  host = String(host || "");
  return IPV4_RE.test(host) || IPV6_RE.test(host) || host.includes(":");
}

export function isIpv6Addr(host) {
  return String(host || "").includes(":") && /^[0-9a-fA-F:.]+$/.test(String(host || ""));
}

export function cleanNodeName(value, fallback = "Node") {
  let t = String(value == null ? "" : value).trim();
  if (!t || /^自定义优选-/i.test(t)) t = fallback;
  t = t.replace(/^\[([^\]]+)\]$/, "$1").replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").replace(/\s+/g, "_");
  return t || fallback;
}

export function nodeBaseName(entry) {
  const host = normalizeHost(entry && (entry.host || entry.ip || entry.domain));
  if (host && isIpv6Addr(host)) return "IPv6优选";
  if (host && !isIpAddr(host)) return "优选域名";
  const name = cleanNodeName(entry && (entry.name || entry.isp || entry.coloo || ""), "IPv4优选");
  return name || "IPv4优选";
}

// ── Live probe gate ──────────────────────────────────────────────────────────
const PROBE_TIMEOUT_MS = 3500;
export const PREF_TTL_MS = 20 * 60 * 1000; // nodes refresh from the freshest pool every 20 min
const PREF_PROBE_CAP = 8;                  // candidates probed per window (≤6 concurrent sockets)
const PREF_LIVE_CAP = 30;                  // live (host,port) pairs kept
const PREF_CACHE_KEY = "pref:live";
const mem = { at: 0, value: null, inflight: null };

async function probePair(host, port) {
  if (!host || !Number.isInteger(port) || port <= 0) return -1;
  const t0 = Date.now();
  let sock = null;
  try {
    sock = await Promise.race([
      connect({ hostname: host, port }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT_MS)),
    ]);
    if (!sock) return -1;
    const ms = Date.now() - t0;
    try { sock.close(); } catch { /* ignore */ }
    return ms;
  } catch {
    try { if (sock && sock.close) sock.close(); } catch { /* ignore */ }
    return -1;
  }
}

// Concurrency-limited probe — Workers allows ≤6 simultaneous sockets.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Build the raw candidate pool in cfnew's exact order: custom addresses win,
// otherwise preferred domains + uouin per-ISP IPs + repo bestip list.
export function buildPool(settings, bestipRows, uouinRows) {
  const custom = (settings.cleanIps || []).map((raw) => {
    let v = String(raw || "").trim();
    let port = 0;
    const m = v.match(/^\[(.+)\]:(\d+)$/) || v.match(/^([^:]+):(\d+)$/);
    if (m && !v.includes("://")) { v = m[1].replace(/^\[|\]$/g, ""); port = parseInt(m[2], 10) || 0; }
    return { host: v, port, name: "自定义优选" };
  }).filter((c) => c.host);
  if (custom.length) return custom; // cfnew: custom preferred replaces remote sources
  const pool = [];
  if (settings.epd !== false) {
    for (const d of PREFERRED_DOMAINS) pool.push({ host: d.domain, port: 0, name: d.name || d.domain });
  }
  if (settings.epi !== false) for (const r of uouinRows || []) pool.push(r);
  if (settings.egi !== false) for (const r of bestipRows || []) pool.push(r);
  return pool;
}

function pairKey(e) { return e.host.toLowerCase() + "|" + e.port + "|" + (e.tls ? "t" : "p"); }

// Expand a candidate into (host, port, tls) pairs with cfnew's port classes.
export function expandPairs(entry, settings) {
  const CF_TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
  const CF_PLAIN_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  const pairs = [];
  const port = Number(entry.port) || 0;
  if (port) {
    if (CF_TLS_PORTS.includes(port)) pairs.push({ ...entry, port, tls: true });
    else if (CF_PLAIN_PORTS.includes(port)) {
      if (settings.nonTls !== false) pairs.push({ ...entry, port, tls: false });
    } else pairs.push({ ...entry, port, tls: true });
  } else {
    for (const p of (settings.ports || [443]).slice(0, 3)) pairs.push({ ...entry, port: p, tls: true });
    if (settings.nonTls !== false) pairs.push({ ...entry, port: 80, tls: false });
  }
  return pairs;
}

// Probed + ranked live addresses (KV + memory cached, rotating probe window).
export async function getLivePreferred(env, settings, force = false) {
  if (!force && mem.value && Date.now() - mem.at < PREF_TTL_MS) return mem.value;
  if (!force) {
    try {
      const raw = await env.SPIDER_KV.get(PREF_CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.value && Date.now() - c.at < PREF_TTL_MS) {
          mem.at = c.at; mem.value = c.value; return mem.value;
        }
      }
    } catch { /* fall through to a live refresh */ }
  }
  if (mem.inflight) return mem.inflight;
  mem.inflight = (async () => {
    let bestipRows = [];
    let uouinRows = [];
    const customEmpty = !(settings.cleanIps || []).length;
    if (customEmpty) {
      const jobs = [];
      if (settings.epi !== false) jobs.push(fetchUouinAddresses().catch(() => []));
      if (settings.egi !== false) jobs.push(fetchBestipList(settings.preferredUrl || DEFAULT_BESTIP_URL).catch(() => []));
      const results = await Promise.all(jobs);
      if (settings.epi !== false) uouinRows = results.shift() || [];
      if (settings.egi !== false) bestipRows = results.pop() || [];
    }
    const pool = buildPool(settings, bestipRows, uouinRows);
    const seen = new Set();
    const unique = pool.filter((p) => {
      if (!p || !p.host) return false;
      const k = p.host.toLowerCase() + "|" + (p.port || 0);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Rotating probe window so the whole pool is covered over time.
    const window = Math.floor(Date.now() / PREF_TTL_MS);
    const start = unique.length ? (window * PREF_PROBE_CAP) % unique.length : 0;
    const head = [];
    for (let i = 0; i < Math.min(PREF_PROBE_CAP, unique.length); i++) head.push(unique[(start + i) % unique.length]);

    const pairs = [];
    for (const c of head) for (const p of expandPairs(c, settings)) pairs.push(p);
    const probed = await mapLimit(pairs, 5, async (p) => {
      const ms = await probePair(p.host, p.port);
      return { ...p, ms, ok: ms >= 0 };
    });
    const live = probed.filter((r) => r.ok).sort((a, b) => a.ms - b.ms).slice(0, PREF_LIVE_CAP);

    const value = { at: Math.floor(Date.now() / 1000), poolSize: unique.length, probedCount: pairs.length, live };
    mem.at = Date.now();
    mem.value = value;
    try {
      await env.SPIDER_KV.put(PREF_CACHE_KEY, JSON.stringify({ at: mem.at, value }), { expirationTtl: 3600 });
    } catch { /* best effort */ }
    return value;
  })();
  try {
    return await mem.inflight;
  } finally {
    mem.inflight = null;
  }
}

export function invalidatePreferred(env) {
  mem.value = null;
  mem.at = 0;
  try { env.SPIDER_KV.delete(PREF_CACHE_KEY); } catch { /* ignore */ }
}
