// SpiderPanel — VLESS tunnel engine + KV helpers (Cloudflare Workers)
// ══════════════════════════════════════════════════════════════════════════════
// Ported from amirh00sain/SpiderPanel (worker/_worker.js) and adapted so the
// panel itself runs on Cloudflare Workers: user records, traffic accounting,
// concurrent-IP limits and country routing all live in Workers KV.
// ══════════════════════════════════════════════════════════════════════════════

import { connect } from "cloudflare:sockets";
import { getCatalogCountryProxies } from "./catalog.js";
import {
  getLivePreferred, invalidatePreferred, nodeBaseName, DEFAULT_BESTIP_URL,
} from "./preferred.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function nowSec() { return Math.floor(Date.now() / 1000); }

export function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomUuid() { return crypto.randomUUID(); }

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a.length || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── Setup / admin token ──────────────────────────────────────────────────────
export async function getSetup(env) {
  try { return JSON.parse((await env.SPIDER_KV.get("spider:setup")) || "null"); }
  catch { return null; }
}

export async function saveSetup(env, setup) {
  await env.SPIDER_KV.put("spider:setup", JSON.stringify(setup));
}

// ── User records ─────────────────────────────────────────────────────────────
export async function getUserRaw(env, uuid) {
  try {
    const raw = await env.SPIDER_KV.get("user:" + (uuid || "").toLowerCase());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function getUser(env, uuid) {
  const u = await getUserRaw(env, uuid);
  if (!u || u.disabled) return null;
  if (u.expire && nowSec() > u.expire) return null;
  if (u.limit_bytes > 0 && (u.used_bytes || 0) >= u.limit_bytes) return null;
  return u;
}

export async function saveUser(env, u) {
  await env.SPIDER_KV.put("user:" + u.uuid, JSON.stringify(u));
}

export async function listUsers(env) {
  const out = [];
  const list = await env.SPIDER_KV.list({ prefix: "user:" });
  for (const k of list.keys) {
    try {
      const u = JSON.parse(await env.SPIDER_KV.get(k.name));
      if (u) out.push(u);
    } catch { /* skip */ }
  }
  return out;
}

// ── Batched traffic accounting (flush to KV every ~1 MiB) ────────────────────
export async function addUsage(env, uuid, n, holder) {
  holder.p = (holder.p || 0) + n;
  if (holder.p < 1048576) return;
  const p = holder.p; holder.p = 0;
  const u = await getUserRaw(env, uuid);
  if (!u) return;
  u.used_bytes = (u.used_bytes || 0) + p;
  await saveUser(env, u);
}

export async function flushUsage(env, uuid, holder) {
  if (!holder || !holder.p || !uuid) return;
  const p = holder.p; holder.p = 0;
  const u = await getUserRaw(env, uuid);
  if (!u) return;
  u.used_bytes = (u.used_bytes || 0) + p;
  await saveUser(env, u);
}

// ── Per-user concurrent-IP limit ─────────────────────────────────────────────
const IP_TTL = 900;
const IP_HEARTBEAT_MS = 300000;

async function getIpList(env, uuid) {
  try {
    const raw = await env.SPIDER_KV.get("ips:" + uuid);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function setIpList(env, uuid, rec) {
  try { await env.SPIDER_KV.put("ips:" + uuid, JSON.stringify(rec)); } catch { /* ignore */ }
}

async function touchIp(env, uuid, ip, maxIp) {
  if (!ip || ip === "unknown" || ip === "127.0.0.1") return true;
  if (!maxIp || maxIp < 1) return true;
  const now = nowSec();
  const rec = (await getIpList(env, uuid)) || { ips: [] };
  const live = rec.ips.filter((x) => x && x.exp > now);
  const existing = live.find((x) => x.ip === ip);
  if (existing) existing.exp = now + IP_TTL;
  else if (live.length >= maxIp) return false;
  else live.push({ ip, exp: now + IP_TTL });
  await setIpList(env, uuid, { ips: live });
  return true;
}

async function removeIp(env, uuid, ip) {
  if (!ip || ip === "unknown" || !uuid) return;
  const rec = await getIpList(env, uuid);
  if (!rec) return;
  const now = nowSec();
  rec.ips = rec.ips.filter((x) => x && x.ip !== ip && x.exp > now);
  await setIpList(env, uuid, rec);
}

export function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0]
    || "unknown").trim();
}

// ── VLESS protocol ───────────────────────────────────────────────────────────
function formatUuid(b) {
  if (!b || b.length !== 16) return "";
  const hex = [];
  for (let i = 0; i < 16; i++) hex.push((b[i] < 16 ? "0" : "") + b[i].toString(16));
  return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" +
    hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10).join("");
}

export function parseVlessHeader(data) {
  if (data.length < 24) return null;
  let pos = 1;
  const userId = formatUuid(data.subarray(pos, pos + 16)); pos += 16;
  const addonLen = data[pos]; pos += 1 + addonLen;
  if (pos + 4 > data.length) return null; // truncated header
  pos += 1; // command byte (1 = TCP)
  const port = (data[pos] << 8) | data[pos + 1]; pos += 2;
  const atype = data[pos]; pos += 1;
  let address;
  if (atype === 1) {
    if (pos + 4 > data.length) return null;
    address = Array.from(data.slice(pos, pos + 4)).join("."); pos += 4;
  } else if (atype === 2) {
    if (pos + 1 > data.length) return null;
    const dlen = data[pos]; pos += 1;
    if (pos + dlen > data.length) return null;
    address = dec.decode(data.subarray(pos, pos + dlen)); pos += dlen;
  } else if (atype === 3) {
    if (pos + 16 > data.length) return null;
    const b = data.subarray(pos, pos + 16); pos += 16;
    const hex = [];
    for (let i = 0; i < 16; i += 2) hex.push(((b[i] << 8) | b[i + 1]).toString(16));
    address = hex.join(":");
  } else return null;
  if (pos > data.length) return null;
  return { userId, address, port, payload: data.subarray(pos) };
}

// Websocket 0-RTT: clients may send the VLESS header b64url-encoded in the
// "Sec-WebSocket-Protocol" header (path ?ed=2048). First protocol value wins.
function earlyDataFromRequest(request) {
  const proto = request.headers.get("sec-websocket-protocol") || "";
  if (!proto) return null;
  try {
    let b64 = proto.split(",")[0].trim().replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null;
  }
}

// ── Locations (country proxies) ──────────────────────────────────────────────
export async function getLocations(env) {
  try { return JSON.parse((await env.SPIDER_KV.get("proxies")) || "[]"); }
  catch { return []; }
}

export async function saveLocations(env, locs) {
  await env.SPIDER_KV.put("proxies", JSON.stringify(locs));
}

// ── Settings ─────────────────────────────────────────────────────────────────
// Mirrors the cfnew engine (byJoey/cfnew) switch by switch:
//   cleanIps     → cfnew `yx`  : manual preferred addresses (empty = auto)
//   epd          → cfnew `epd` : preferred domain list (直连域名列表)
//   epi          → cfnew `epi` : per-ISP preferred IPs (uouin API)
//   egi          → cfnew `egi` : repo bestip list (仓库优选)
//   preferredUrl → cfnew `yxURL`: custom bestip source URL
//   nonTls       → cfnew `et`  : also emit security=none nodes on HTTP ports
//   ech          → cfnew `ech` : ECH link parameter (fp becomes chrome)
//   alpn/dnsUrl  → cfnew alpn/customDNS
// outboundMode controls the server-side country relay; direct-first is the
// default so a normal VLESS node never applies a proxy unnecessarily.
const PORT_DEFAULTS = [443];
const DEFAULT_DNS_URL = "https://223.5.5.5/dns-query";
const ALPN_VALUES = new Set(["h3", "h2", "http/1.1"]);

function normalizeSettings(s) {
  s = s && typeof s === "object" ? s : {};
  const ports = Array.isArray(s.ports)
    ? s.ports.map(Number).filter((p) => p > 0 && p < 65536).slice(0, 6)
    : PORT_DEFAULTS.slice();
  const cleanIps = Array.isArray(s.cleanIps)
    ? s.cleanIps.map((x) => String(x).trim()).filter(Boolean).slice(0, 40)
    : [];
  const alpn = Array.isArray(s.alpn)
    ? s.alpn.map((x) => String(x).trim()).filter((x) => ALPN_VALUES.has(x)).slice(0, 3)
    : [];
  return {
    catalogRouting: s.catalogRouting !== false,
    cleanIps,
    ports: ports.length ? ports : PORT_DEFAULTS.slice(),
    outboundMode: ["proxy-first", "direct-first", "proxy-only"].includes(s.outboundMode) ? s.outboundMode : "direct-first",
    ech: s.ech === true,
    echQueryDomain: String(s.echQueryDomain || "cloudflare-ech.com").trim() || "cloudflare-ech.com",
    alpn,
    epd: s.epd !== false,
    epi: s.epi !== false,
    egi: s.egi !== false,
    nonTls: s.nonTls !== false,
    preferredUrl: String(s.preferredUrl || "").trim(),
    dnsUrl: String(s.dnsUrl || "").trim() || DEFAULT_DNS_URL,
  };
}

const SETTINGS_CACHE = { at: 0, value: null };
const SETTINGS_CACHE_MS = 30000;

export async function getSettings(env) {
  if (SETTINGS_CACHE.value && Date.now() - SETTINGS_CACHE.at < SETTINGS_CACHE_MS) return SETTINGS_CACHE.value;
  try {
    const s = JSON.parse((await env.SPIDER_KV.get("spider:settings")) || "null");
    SETTINGS_CACHE.value = normalizeSettings(s);
  } catch { SETTINGS_CACHE.value = normalizeSettings(null); }
  SETTINGS_CACHE.at = Date.now();
  return SETTINGS_CACHE.value;
}

export async function saveSettings(env, s) {
  const value = normalizeSettings(s);
  await env.SPIDER_KV.put("spider:settings", JSON.stringify(value));
  SETTINGS_CACHE.value = value;
  SETTINGS_CACHE.at = Date.now();
  return value;
}

export function parseEndpoint(entry, defaultPort = 443) {
  let value = String(entry || "").trim();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const host = value.slice(1, end);
    const port = value.slice(end + 1).startsWith(":") ? Number(value.slice(end + 2)) : defaultPort;
    return host && port > 0 && port < 65536 ? { host, port } : null;
  }
  const last = value.lastIndexOf(":");
  if (last > 0 && value.indexOf(":") === last) {
    const port = Number(value.slice(last + 1));
    if (port > 0 && port < 65536) return { host: value.slice(0, last), port };
  }
  return { host: value, port: defaultPort };
}

// TCP probe kept for the panel latency tool (catalog proxies / manual hosts).
// Preferred addresses are gated by the dedicated probe in preferred.js.
export async function probeTcpEndpoint(host, port = 443, timeoutMs = 3500) {
  const connector = getConnector();
  if (!connector || !host || !Number.isInteger(Number(port))) return { ok: false, ms: -1 };
  const started = Date.now();
  let socket = null;
  try {
    socket = await Promise.race([
      connector({ hostname: String(host), port: Number(port) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), timeoutMs)),
    ]);
    const ms = Date.now() - started;
    try { socket.close(); } catch { /* ignore */ }
    return { ok: true, ms };
  } catch {
    try { socket && socket.close && socket.close(); } catch { /* ignore */ }
    return { ok: false, ms: -1 };
  }
}

function countryProxyList(loc) {
  if (!loc) return [];
  const seen = new Set(); const out = [];
  const add = (p) => {
    p = String(p || "").trim();
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  };
  add(loc.proxy);
  for (const p of loc.proxies || []) add(p);
  return out;
}

// ── Outbound sockets & proxy protocols ───────────────────────────────────────
function getConnector() { return typeof connect === "function" ? connect : null; }

export function parseProxyEntry(entry, defaultPort) {
  if (!entry) return null;
  let e = String(entry).trim();
  // Bare ip / ip:port entries are raw VLESS relays on :443 — plain TCP streams;
  // the client's own TLS ClientHello flows through and the edge routes by SNI.
  let protocol = "relay";
  const m = e.match(/^(socks5|socks4|http|https):\/\//i);
  if (m) { protocol = m[1].toLowerCase(); e = e.slice(m[0].length); }
  const isBare = !m && /^[^@/]+$/.test(e);
  e = e.split("#")[0].trim();
  let username = "", password = "";
  const at = e.lastIndexOf("@");
  if (at >= 0) {
    const auth = e.slice(0, at);
    e = e.slice(at + 1);
    const ai = auth.indexOf(":");
    if (ai >= 0) { username = decodeURIComponent(auth.slice(0, ai)); password = decodeURIComponent(auth.slice(ai + 1)); }
    else username = decodeURIComponent(auth);
  }
  let hostname = e, port = defaultPort || (protocol === "relay" ? 443 : 80);
  if (e.startsWith("[")) {
    const j = e.indexOf("]");
    if (j > 0) { hostname = e.slice(1, j); if (e[j + 1] === ":") port = parseInt(e.slice(j + 2)) || port; }
  } else {
    const j = e.lastIndexOf(":");
    if (j > 0 && e.indexOf(":") === j) { hostname = e.slice(0, j); port = parseInt(e.slice(j + 1)) || port; }
  }
  if (!hostname) return null;
  return { protocol: isBare ? "relay" : protocol, hostname, port, username, password };
}

async function openSocket(hostname, port) {
  const connector = getConnector();
  if (!connector) return null;
  try {
    const sock = await connector({ hostname, port });
    if (!sock || !sock.readable || !sock.writable) return null;
    return { socket: sock, reader: sock.readable.getReader(), writer: sock.writable.getWriter() };
  } catch { return null; }
}

// TLS to the proxy itself (https:// entries): TCP connect, then startTls on the
// same socket. Same conn shape as openSocket; the HTTP CONNECT then runs
// encrypted (RFC 2817 "https" proxy).
async function openTlsSocket(hostname, port, servername) {
  const base = await openSocket(hostname, port);
  if (!base) return null;
  try {
    const tls = base.socket.startTls({ servername: servername || hostname });
    return { socket: base.socket, reader: tls.readable.getReader(), writer: tls.writable.getWriter() };
  } catch {
    try { base.socket.close(); } catch { /* ignore */ }
    return null;
  }
}

async function httpConnectOn(conn, proxy, targetHost, targetPort) {
  try {
    let authority = targetHost.includes(":") ? "[" + targetHost + "]" : targetHost;
    authority += ":" + targetPort;
    let auth = "";
    if (proxy.username) {
      const raw = enc.encode(proxy.username + ":" + (proxy.password || ""));
      let bin = "";
      for (const b of raw) bin += String.fromCharCode(b);
      auth = "Proxy-Authorization: Basic " + btoa(bin) + "\r\n";
    }
    const req = "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n" + auth + "Connection: keep-alive\r\n\r\n";
    await conn.writer.write(enc.encode(req));
    let buf = new Uint8Array(0);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const r = await Promise.race([
        conn.reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("proxy timeout")), 2500)),
      ]);
      if (r.done) throw new Error("proxy closed");
      const merged = new Uint8Array(buf.length + r.value.length);
      merged.set(buf); merged.set(r.value, buf.length); buf = merged;
      const txt = dec.decode(buf);
      const idx = txt.indexOf("\r\n\r\n");
      if (idx >= 0) {
        const first = txt.slice(0, idx).split("\r\n")[0];
        if (!/HTTP\/\d\.\d\s+2\d\d/.test(first)) throw new Error("HTTP CONNECT failed: " + first);
        return conn;
      }
    }
    throw new Error("proxy header timeout");
  } catch {
    try { conn.socket.close(); } catch { /* ignore */ }
    return null;
  }
}

async function httpConnect(proxy, targetHost, targetPort) {
  const conn = await openSocket(proxy.hostname, proxy.port);
  if (!conn) return null;
  return httpConnectOn(conn, proxy, targetHost, targetPort);
}

async function socks5Connect(proxy, targetHost, targetPort) {
  const conn = await openSocket(proxy.hostname, proxy.port);
  if (!conn) return null;
  try {
    const hello = proxy.username ? new Uint8Array([5, 2, 0, 2]) : new Uint8Array([5, 1, 0]);
    await conn.writer.write(hello);
    const h = await conn.reader.read();
    if (h.done || h.value.length < 2 || h.value[0] !== 5) throw new Error("bad socks5 hello");
    if (h.value[1] === 2) {
      if (!proxy.username) throw new Error("socks auth required");
      const u = enc.encode(proxy.username), pw = enc.encode(proxy.password || "");
      const msg = new Uint8Array(3 + u.length + pw.length);
      msg[0] = 1; msg[1] = u.length; msg.set(u, 2); msg[2 + u.length] = pw.length; msg.set(pw, 3 + u.length);
      await conn.writer.write(msg);
      const a = await conn.reader.read();
      if (a.done || a.value[1] !== 0) throw new Error("socks auth failed");
    } else if (h.value[1] !== 0) throw new Error("socks method rejected");
    const hostBytes = enc.encode(targetHost);
    const req = new Uint8Array(7 + hostBytes.length);
    req[0] = 5; req[1] = 1; req[2] = 0; req[3] = 3; req[4] = hostBytes.length;
    req.set(hostBytes, 5);
    req[5 + hostBytes.length] = (targetPort >> 8) & 255;
    req[6 + hostBytes.length] = targetPort & 255;
    await conn.writer.write(req);
    const r = await conn.reader.read();
    if (r.done || r.value.length < 2 || r.value[1] !== 0) throw new Error("socks connect failed");
    return conn;
  } catch {
    try { conn.socket.close(); } catch { /* ignore */ }
    return null;
  }
}

async function connectViaProxy(proxyEntry, targetHost, targetPort, loc) {
  const proxy = parseProxyEntry(proxyEntry, loc && Number(loc.port) ? Number(loc.port) : undefined);
  if (!proxy) return null;
  if (proxy.protocol === "https") {
    const conn = await openTlsSocket(proxy.hostname, proxy.port);
    if (!conn) return null;
    return httpConnectOn(conn, proxy, targetHost, targetPort);
  }
  if (proxy.protocol === "socks5" || proxy.protocol === "socks4") return socks5Connect(proxy, targetHost, targetPort);
  if (proxy.protocol === "relay") {
    // Successful TCP open is enough; relays never send a greeting, and reading
    // first would swallow part of the client's TLS handshake bytes.
    return openSocket(proxy.hostname, proxy.port);
  }
  return httpConnect(proxy, targetHost, targetPort);
}

// ── Fastest-proxy balancer ───────────────────────────────────────────────────
const PROBE_TIMEOUT_MS = 4000;
const PROBE_TTL_MS = 20 * 60 * 1000; // refresh the live pool every 20 minutes
const HEALTH_TTL_SEC = 1200;
const HEALTH_PROBE_MAX = 20;
const FASTEST_CACHE = Object.create(null); // country code → { order, at }

async function probeProxyLatency(entry, loc) {
  const t0 = Date.now();
  const proxy = parseProxyEntry(entry, loc && Number(loc.port) ? Number(loc.port) : undefined);
  if (!proxy || !proxy.hostname) return -1;
  const connector = getConnector();
  if (!connector) return -1;
  let sock = null;
  try {
    sock = await Promise.race([
      connector({ hostname: proxy.hostname, port: proxy.port }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT_MS)),
    ]);
    if (!sock || !sock.readable || !sock.writable) return -1;
    const ms = Date.now() - t0;
    try { sock.close(); } catch { /* ignore */ }
    return ms;
  } catch {
    try { if (sock && sock.close) sock.close(); } catch { /* ignore */ }
    return -1;
  }
}

async function rankProxyEntries(env, country, entries, loc) {
  const list = [...new Set((entries || []).map((e) => String(e || "").trim()).filter(Boolean))];
  if (!list.length) return [];
  const key = String(country || "x").toLowerCase();
  const cached = FASTEST_CACHE[key];
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return cached.order.filter((entry) => list.includes(entry));
  }
  try {
    const raw = await env.SPIDER_KV.get("health:" + key);
    const stored = raw ? JSON.parse(raw) : null;
    if (stored && stored.at && Date.now() - stored.at < PROBE_TTL_MS) {
      const order = (stored.results || []).filter((r) => r && r.ok).sort((a, b) => a.ms - b.ms).map((r) => r.entry);
      FASTEST_CACHE[key] = { order, at: stored.at };
      return order.filter((entry) => list.includes(entry));
    }
  } catch { /* health cache is best effort */ }

  // Only publish entries that passed a real TCP connect. The list is capped to
  // keep a cold Worker within its subrequest budget. Rotate the probe window
  // every 20 minutes so a large catalog is not permanently stuck on its first
  // rows.
  const window = Math.floor(Date.now() / PROBE_TTL_MS);
  const start = list.length ? (window * HEALTH_PROBE_MAX) % list.length : 0;
  const head = list.slice(start, start + HEALTH_PROBE_MAX).concat(
    start + HEALTH_PROBE_MAX > list.length ? list.slice(0, (start + HEALTH_PROBE_MAX) % list.length) : []
  );
  const results = await Promise.all(head.map(async (entry) => {
    const ms = await probeProxyLatency(entry, loc);
    return { entry, ms, ok: ms >= 0 };
  }));
  const order = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms).map((r) => r.entry);
  const at = Date.now();
  FASTEST_CACHE[key] = { order, at };
  try {
    await env.SPIDER_KV.put("health:" + key, JSON.stringify({ at, results }), { expirationTtl: HEALTH_TTL_SEC * 2 });
  } catch { /* health cache is best effort */ }
  return order;
}

export async function getCountryHealth(env, country, entries, loc) {
  const list = [...new Set((entries || []).map((e) => String(e || "").trim()).filter(Boolean))];
  const key = String(country || "x").toLowerCase();
  let results = null;
  try {
    const raw = await env.SPIDER_KV.get("health:" + key);
    const stored = raw ? JSON.parse(raw) : null;
    if (stored && stored.at && Date.now() - stored.at < PROBE_TTL_MS) results = stored.results || [];
  } catch { /* fall through to a live probe */ }
  if (!results) {
    await rankProxyEntries(env, country, list, loc);
    try {
      const raw = await env.SPIDER_KV.get("health:" + key);
      const stored = raw ? JSON.parse(raw) : null;
      results = stored && stored.results ? stored.results : [];
    } catch { results = []; }
  }
  return results.filter((r) => list.includes(r.entry)).sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.ms - b.ms));
}

async function rankCountryProxies(env, loc) {
  // Rank manual relays first, then merge in the LIVE preferred-address pool
  // from the cfnew engine (preferred domains + per-ISP IPs + repo bestip).
  // Preferred entries are gated by a live TCP probe, so only reachable
  // addresses ever win the race — relays are probed on connect anyway.
  const manual = await rankProxyEntries(env, loc && (loc.code || loc.country), countryProxyList(loc), loc);
  const settings = await getSettings(env);
  const preferred = await getLivePreferred(env, settings);
  const preferredEntries = (preferred.live || []).map((p) => (p.tls ? "https://" : "http://") + p.host + ":" + p.port);
  return [...manual, ...preferredEntries];
}

// Resolve the outbound connection for a tunnel session.
// Country routes: manual location pool first (fastest-probe order), then the
// LIVE preferred pool (cfnew) + catalog for that country. Direct routes:
// user.proxy_ip, or direct egress with anti-loop (never back into this Worker).
const TRY_MAX = 5;

export async function connectOutbound(env, country, user, targetHost, targetPort, workerHost) {
  const settings = await getSettings(env);
  let candidates = [];
  let loc = null;
  if (country) {
    loc = (await getLocations(env)).find((x) => String(x.code || "").toLowerCase() === String(country).toLowerCase()) || null;
    candidates = await rankCountryProxies(env, loc);
    if (settings.catalogRouting) {
      const catProxies = await getCatalogCountryProxies(env, country);
      const catalogEntries = catProxies.map((p) => p.entry);
      const allEntries = [...new Set(countryProxyList(loc).concat(catalogEntries))];
      candidates = await rankProxyEntries(env, country, allEntries, loc);
    }
    if (!candidates.length && settings.outboundMode === "proxy-only") return null;
  } else {
    candidates = [String(user.proxy_ip || "").trim()].filter(Boolean);
  }
  let tried = 0;
  const direct = () => {
    const target = String(targetHost || "").toLowerCase();
    if (target && target !== String(workerHost || "").toLowerCase()) return openSocket(target, targetPort);
    return null;
  };
  // A normal / VLESS node is direct by default. An explicit /route/{country}
  // node must still honor its country, so it never skips the selected relay
  // merely because the global mode is direct-first.
  if (!country && settings.outboundMode === "direct-first") {
    const first = await direct();
    if (first) return first;
  }
  for (const entry of candidates) {
    if (tried >= TRY_MAX) break;
    tried++;
    const conn = await connectViaProxy(entry, targetHost, targetPort, loc);
    if (conn) return conn;
  }
  // Cached ranking may be stale — re-race the manual pool once so a dead entry
  // never blocks (catalog rows below are already tried in the loop above).
  if (country && loc) {
    delete FASTEST_CACHE[String(loc.code || loc.country || "x").toLowerCase()];
    const fresh = await rankProxyEntries(env, country, countryProxyList(loc), loc);
    const rest = fresh.filter((e) => !candidates.slice(0, tried).includes(e));
    for (const entry of rest) {
      if (tried >= TRY_MAX * 2) break;
      tried++;
      const conn = await connectViaProxy(entry, targetHost, targetPort, loc);
      if (conn) return conn;
    }
  }
  if (settings.outboundMode !== "proxy-only") {
    const fallback = await direct();
    if (fallback) return fallback;
  }
  return null;
}

// ── Config generation (cfnew engine) ────────────────────────────────────
// Mirrors byJoey/cfnew's node pipeline: the address pool comes from the live
// preferred sources (custom → preferred domains → per-ISP IPs → repo bestip),
// every address passes a live TCP probe before it becomes a node, and links
// are shaped exactly like cfnew's: path=/?ed=2048, eh=Sec-WebSocket-Protocol,
// fp=randomized (chrome when ECH is on), alpn + ech=<domain>+<dns>.
const CONFIG_CAP = 200;
export async function nodesForUser(env, u, domain, settings) {
  const s = normalizeSettings(settings);
  const countries = Array.isArray(u.countries) && u.countries.length ? u.countries : [""];
  const live = await getLivePreferred(env, s);
  const counters = new Map();
  const nodes = [];
  for (const pair of (live.live || []).slice(0, 10)) {
    const base = nodeBaseName(pair);
    counters.set(base, (counters.get(base) || 0) + 1);
    const name = base + "-" + String(counters.get(base)).padStart(2, "0");
    for (const code of countries) {
      const path = code ? "/route/" + encodeURIComponent(String(code).toLowerCase()) : "/?ed=2048";
      nodes.push({
        tag: (u.remark || "user") + "-" + name,
        uuid: u.uuid,
        address: pair.host.includes(":") ? "[" + pair.host + "]" : pair.host,
        port: pair.port,
        host: domain,
        path,
        earlyData: 2048,
        tls: pair.tls !== false,
        country: code || "",
      });
    }
  }
  return nodes.slice(0, CONFIG_CAP);
}

function vlessLink(node, settings) {
  const s = normalizeSettings(settings);
  const addr = String(node.address || "");
  const q = "encryption=none&security=" + (node.tls === false ? "none" : "tls") +
    (node.tls === false ? "" : "&sni=" + encodeURIComponent(node.host)) +
    "&fp=" + (s.ech ? "chrome" : "randomized") + "&type=ws&host=" + encodeURIComponent(node.host) +
    "&path=" + encodeURIComponent(node.path) + "&ed=" + node.earlyData + "&eh=Sec-WebSocket-Protocol" +
    (s.alpn.length ? "&alpn=" + encodeURIComponent(s.alpn.join(",")) : "") +
    (s.ech ? "&ech=" + encodeURIComponent(s.echQueryDomain + "+" + s.dnsUrl) : "");
  return "vless://" + node.uuid + "@" + addr + ":" + node.port + "?" + q +
    "#" + encodeURIComponent(node.tag);
}

export async function vlessConfigsForUser(env, u, domain, settings) {
  const nodes = await nodesForUser(env, u, domain, settings);
  return nodes.map((n) => vlessLink(n, settings));
}

function yamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function toYaml(value, level = 0) {
  const pad = "  ".repeat(level);
  if (value === null || typeof value !== "object") return yamlScalar(value);
  const lines = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const nested = toYaml(item, level + 1).split("\n");
        lines.push(pad + "-");
        lines.push(...nested);
      } else lines.push(pad + "- " + yamlScalar(item));
    }
    return lines.join("\n");
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (item && typeof item === "object") {
      lines.push(pad + key + ":");
      lines.push(toYaml(item, level + 1));
    } else lines.push(pad + key + ": " + yamlScalar(item));
  }
  return lines.join("\n");
}

export async function clashConfigForUsers(env, users, domain, settings) {
  const normalized = normalizeSettings(settings);
  const nodeLists = await Promise.all(users.map((u) => nodesForUser(env, u, domain, normalized)));
  const usedTags = new Set();
  const proxies = [];
  for (const node of nodeLists.flat().slice(0, CONFIG_CAP)) {
    let name = node.tag;
    let suffix = 2;
    while (usedTags.has(name)) name = node.tag + "-" + suffix++;
    usedTags.add(name);
    const isTls = node.tls !== false;
    const proxy = {
      name,
      type: "vless",
      server: node.address,
      port: node.port,
      uuid: node.uuid,
      udp: true,
      tls: isTls,
      servername: node.host,
      network: "ws",
      "ws-opts": {
        path: node.path,
        headers: { Host: node.host },
        "max-early-data": node.earlyData,
        "early-data-header-name": "Sec-WebSocket-Protocol",
      },
      "client-fingerprint": normalized.ech ? "chrome" : "randomized",
    };
    if (normalized.alpn.length) proxy.alpn = normalized.alpn;
    if (normalized.ech && isTls) proxy["ech-opts"] = { enabled: true, "query-server-name": normalized.echQueryDomain };
    proxies.push(proxy);
  }
  const tags = proxies.map((p) => p.name);
  const groups = [
    { name: "🚀节点选择", type: "select", proxies: ["DIRECT"].concat(tags) },
    { name: "⚡自动切换", type: "fallback", proxies: tags, url: "https://www.gstatic.com/generate_204", interval: 300 },
  ];
  const countries = [...new Set(nodeLists.flat().map((n) => n.country).filter(Boolean))];
  for (const code of countries) {
    const countryTags = proxies.filter((p) => p.name.toLowerCase().includes("-" + code.toLowerCase() + "-")).map((p) => p.name);
    if (countryTags.length) groups.push({ name: "🌍 " + code.toUpperCase(), type: "select", proxies: ["🚀节点选择"].concat(countryTags) });
  }
  groups.push({ name: "🎯全球直连", type: "select", proxies: ["DIRECT"] });
  return toYaml({
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    "log-level": "silent",
    ipv6: false,
    dns: { enable: true, "enhanced-mode": "fake-ip", "fake-ip-range": "198.18.0.1/16", nameserver: ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"] },
    proxies,
    "proxy-groups": groups,
    rules: ["DOMAIN-SUFFIX,cn,DIRECT", "GEOIP,CN,DIRECT", "MATCH,🚀节点选择"],
  }) + "\\n";
}

// ── sing-box template conversion ───────────────────────────────────────────
// Mirrors the structure of the reference template the user pointed at: fakeip
// DNS + rule-based servers, mixed + tun inbounds, per-service selector groups
// that all fall back to the main selector, one VLESS outbound per node with
// ws transport + 0-RTT early data + randomized uTLS, urltest groups per country.
function singboxOutbound(node, settings) {
  const s = normalizeSettings(settings);
  const isTls = node.tls !== false;
  const out = {
    type: "vless",
    tag: node.tag,
    server: node.address,
    server_port: node.port,
    uuid: node.uuid,
    tls: {
      enabled: isTls,
      server_name: node.host,
      insecure: false,
      utls: { enabled: true, fingerprint: s.ech ? "chrome" : "randomized" },
      ...(s.alpn.length ? { alpn: s.alpn } : {}),
      ...(s.ech ? { ech: { enabled: true, query_domain: s.echQueryDomain } } : {}),
    },
    transport: {
      type: "ws",
      path: node.path,
      headers: { Host: node.host },
      max_early_data: node.earlyData,
      early_data_header_name: "Sec-WebSocket-Protocol",
    },
  };
  return out;
}

export async function singboxConfigForUsers(env, users, domain, settings) {
  const normalized = normalizeSettings(settings);
  const nodeLists = await Promise.all(users.map((u) => nodesForUser(env, u, domain, normalized)));
  const nodes = nodeLists.flat().slice(0, CONFIG_CAP);
  const tags = nodes.map((n) => n.tag);

  const serviceGroups = [
    { tag: "🌐 国外媒体", first: "select" },
    { tag: "📲 电报信息", first: "select" },
    { tag: "🌐 谷歌服务", first: "select" },
    { tag: "🤖 OpenAI", first: "select" },
    { tag: "Ⓜ️ 微软服务", first: "direct" },
    { tag: "🍎 苹果服务", first: "direct" },
    { tag: "📺 哔哩哔哩", first: "direct" },
    { tag: "📹 油管视频", first: "select" },
    { tag: "🎬 奈飞视频", first: "select" },
    { tag: "🐟 漏网之鱼", first: "select" },
  ];
  const outbounds = [];
  outbounds.push({ type: "selector", tag: "select", outbounds: ["direct"].concat(tags), default: tags[0] || "direct" });
  for (const g of serviceGroups) {
    outbounds.push({ type: "selector", tag: g.tag, outbounds: [g.first, "select"].concat(tags) });
  }
  outbounds.push({ type: "selector", tag: "🎯 全球直连", outbounds: ["direct"] });
  for (const n of nodes) outbounds.push(singboxOutbound(n, normalized));

  // Country urltest groups for the countries actually present in the sub.
  const byCountry = new Map();
  for (const n of nodes) {
    if (!n.country) continue;
    if (!byCountry.has(n.country)) byCountry.set(n.country, []);
    byCountry.get(n.country).push(n.tag);
  }
  for (const [code, ts] of byCountry) {
    if (ts.length > 1) outbounds.push({ type: "urltest", tag: "⚡ " + code.toUpperCase() + " 自动", outbounds: ts, tolerance: 50 });
  }

  return {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        { tag: "remote", address: normalized.dnsUrl, detour: "select" },
        { tag: "local", address: "223.5.5.5", detour: "direct" },
        { tag: "fakeip", address: "fakeip" },
        { tag: "block", address: "rcode://success" },
      ],
      rules: [
        { outbound: "any", server: "local" },
        { rule_set: "geosite-category-ads-all", server: "block" },
        { rule_set: "geosite-cn", server: "local" },
        { query_type: ["A", "AAAA"], server: "fakeip" },
      ],
      fakeip: { enabled: true, inet4_range: "198.18.0.0/15", inet6_range: "fc00::/18" },
      independent_cache: true,
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080,
        sniff: true, sniff_override_destination: true,
      },
      {
        type: "tun", tag: "tun-in", interface_name: "sing-box",
        address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
        mtu: 9000, auto_route: true, strict_route: true, stack: "mixed",
        sniff: true, sniff_override_destination: true,
      },
    ],
    outbounds,
    route: {
      auto_detect_interface: true,
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
        { rule_set: ["geosite-cn"], outbound: "🎯 全球直连" },
        { rule_set: ["geoip-cn"], outbound: "🎯 全球直连" },
        { rule_set: ["geosite-openai"], outbound: "🤖 OpenAI" },
        { rule_set: ["geosite-netflix"], outbound: "🎬 奈飞视频" },
        { rule_set: ["geosite-category-ads-all"], outbound: "🎯 全球直连" },
        { rule_set: ["geosite-google", "geosite-youtube"], outbound: "📹 油管视频" },
        { rule_set: ["geosite-telegram"], outbound: "📲 电报信息" },
        { rule_set: ["geosite-microsoft", "geosite-github"], outbound: "Ⓜ️ 微软服务" },
        { rule_set: ["geosite-apple"], outbound: "🍎 苹果服务" },
        { rule_set: ["geosite-category-entertainment", "geosite-bilibili"], outbound: "📺 哔哩哔哩" },
        { rule_set: ["geosite-googlefcm"], outbound: "🎯 全球直连" },
        { rule_set: ["geosite-category-games"], outbound: "🐟 漏网之鱼" },
        { outbound: "any", server: "local" },
        { ip_cidr: ["223.5.5.5/32"], outbound: "direct" },
      ],
      rule_set: [
        { type: "remote", tag: "geosite-cn", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs", download_detour: "select" },
        { type: "remote", tag: "geoip-cn", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-openai", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-openai.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-netflix", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-netflix.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-category-ads-all", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-google", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-google.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-youtube", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-youtube.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-telegram", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-telegram.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-microsoft", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-microsoft.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-github", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-github.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-apple", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-apple.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-bilibili", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-bilibili.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-category-entertainment", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-entertainment.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-googlefcm", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-googlefcm.srs", download_detour: "select" },
        { type: "remote", tag: "geosite-category-games", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-games.srs", download_detour: "select" },
      ],
      final: "🐟 漏网之鱼",
    },
    experimental: {
      cache_file: { enabled: true, store_fakeip: true },
      clash_api: { external_controller: "127.0.0.1:9090", default_mode: "rule" },
    },
  };
}

// ── VLESS WebSocket tunnel ───────────────────────────────────────────────────
export async function handleVlessWs(request, env, country, preUser) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.binaryType = "arraybuffer";
  const connIp = clientIp(request);
  const usage = { p: 0 };
  const workerHost = (request && request.headers.get("host")) || "";

  // 0-RTT: the first WS message may already be in flight when this runs, so
  // the queued header is consumed lazily on the first message event.
  server.addEventListener("message", async (ev) => {
    let data = new Uint8Array(ev.data);
    if (!server.__h) {
      const early = server.__early || (server.__early = earlyDataFromRequest(request));
      if (early && early.length) {
        const merged = new Uint8Array(early.length + data.length);
        merged.set(early); merged.set(data, early.length);
        data = merged;
        server.__early = null;
      }
      const h = parseVlessHeader(data);
      if (!h) { try { server.close(4002, "bad header"); } catch { /* ignore */ } return; }
      server.__h = h;
      let user = preUser;
      if (!user && h.userId) user = await getUser(env, h.userId.toLowerCase());
      if (!user) { try { server.close(4030, "unauthorized"); } catch { /* ignore */ } return; }
      server.__user = user;
      if (!await touchIp(env, user.uuid, connIp, user.concurrent_connections)) {
        try { server.close(4031, "ip limit reached"); } catch { /* ignore */ }
        return;
      }
      if (!server.__hb) {
        server.__hb = setInterval(async () => {
          await touchIp(env, user.uuid, connIp, user.concurrent_connections);
        }, IP_HEARTBEAT_MS);
      }
      const conn = await connectOutbound(env, country, user, h.address, h.port, workerHost);
      if (!conn) {
        try { server.close(4001, "outbound connect failed"); } catch { /* ignore */ }
        return;
      }
      server.__conn = conn;
      server.__wsToTcp = async (chunk) => {
        try { await conn.writer.write(chunk); }
        catch { try { server.close(4003); } catch { /* ignore */ } }
      };
      if (h.payload.length) {
        try { await conn.writer.write(h.payload); } catch { /* ignore */ }
        addUsage(env, user.uuid, h.payload.length, usage);
      }
      if (early) addUsage(env, user.uuid, early.length, usage);
      pumpTcpToWs(conn, server);
      return;
    }
    if (server.__wsToTcp) {
      server.__wsToTcp(data);
      addUsage(env, server.__user.uuid, data.length, usage);
    }
  });

  server.addEventListener("close", async () => {
    if (server.__hb) clearInterval(server.__hb);
    try { server.__conn && server.__conn.socket.close(); } catch { /* ignore */ }
    await flushUsage(env, server.__user && server.__user.uuid, usage);
    await removeIp(env, server.__user && server.__user.uuid, connIp);
  });
  server.addEventListener("error", async () => {
    if (server.__hb) clearInterval(server.__hb);
    try { server.__conn && server.__conn.socket.close(); } catch { /* ignore */ }
    await flushUsage(env, server.__user && server.__user.uuid, usage);
    await removeIp(env, server.__user && server.__user.uuid, connIp);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function pumpTcpToWs(conn, server) {
  let sentVlessResponseHeader = false;
  try {
    while (true) {
      const { done, value } = await conn.reader.read();
      if (done) break;
      if (value && value.length) {
        // The 2-byte VLESS response header is sent once — prefixing every TCP
        // chunk with 00 00 corrupts TLS/HTTP streams.
        let frame = value;
        if (!sentVlessResponseHeader) {
          frame = new Uint8Array(value.length + 2);
          frame[0] = 0; frame[1] = 0; frame.set(value, 2);
          sentVlessResponseHeader = true;
        }
        try { server.send(frame); } catch { break; }
      }
    }
  } catch { /* silent close */ }
  try { server.close(1000); } catch { /* ignore */ }
}
