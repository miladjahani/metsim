// SpiderPanel — VLESS tunnel engine + KV helpers (Cloudflare Workers)
// ══════════════════════════════════════════════════════════════════════════════
// Ported from amirh00sain/SpiderPanel (worker/_worker.js) and adapted so the
// panel itself runs on Cloudflare Workers: user records, traffic accounting,
// concurrent-IP limits and country routing all live in Workers KV.
// ══════════════════════════════════════════════════════════════════════════════

import { connect } from "cloudflare:sockets";
import { getCatalogCountryProxies } from "./catalog.js";

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
// catalogRouting: catalog countries act as locations automatically (default on).
// cdnHosts: extra TLS fronting hosts (CDN / clean IPs) mixed into every user's
//   subscription alongside the worker domain — server-side, so end users only
//   refresh their sub link to pick up changes.
// ports: TLS ports offered on workers.dev / CDN fronting (443, 2053, 2083…).
// fragment: append Xray TLS-fragment option (tlshello splitting) to configs.
const CDN_DEFAULTS = ["speed.cloudflare.com", "icook.hk", "time.is", "cf.090227.xyz", "ip.sb"];
const PORT_DEFAULTS = [443, 2053, 2083];

function normalizeSettings(s) {
  s = s && typeof s === "object" ? s : {};
  const cdn = Array.isArray(s.cdnHosts)
    ? s.cdnHosts.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
    : CDN_DEFAULTS;
  const ports = Array.isArray(s.ports)
    ? s.ports.map(Number).filter((p) => p > 0 && p < 65536).slice(0, 6)
    : PORT_DEFAULTS.slice();
  return {
    catalogRouting: s.catalogRouting !== false,
    cdnHosts: cdn.length ? cdn : CDN_DEFAULTS,
    ports: ports.length ? ports : [443],
    fragment: s.fragment !== false,
  };
}

export async function getSettings(env) {
  try {
    const s = JSON.parse((await env.SPIDER_KV.get("spider:settings")) || "null");
    return normalizeSettings(s);
  } catch { return normalizeSettings(null); }
}

export async function saveSettings(env, s) {
  await env.SPIDER_KV.put("spider:settings", JSON.stringify(s));
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
const PROBE_TTL_MS = 120000;
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

async function rankCountryProxies(loc) {
  const list = countryProxyList(loc);
  if (!loc || list.length <= 1) return list;
  const key = String(loc.code || loc.country || "x").toLowerCase();
  const cached = FASTEST_CACHE[key];
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    const alive = cached.order.filter((e) => list.includes(e));
    for (const p of list) if (!alive.includes(p)) alive.push(p);
    return alive;
  }
  // Probe at most PROBE_MAX entries per country per cache window — racing
  // hundreds of sockets would blow the request budget on big lists.
  const head = list.slice(0, PROBE_MAX);
  const tail = list.slice(PROBE_MAX);
  const results = await Promise.all(head.map(async (e) => ({ e, ms: await probeProxyLatency(e, loc) })));
  results.sort((a, b) => (a.ms < 0 ? 1 : b.ms < 0 ? -1 : a.ms - b.ms));
  const order = results.map((r) => r.e).concat(tail);
  FASTEST_CACHE[key] = { order, at: Date.now() };
  return order;
}

// Resolve the outbound connection for a tunnel session.
// Country routes: manual location pool first (fastest-probe order), then the
// LIVE catalog for that country (EDT-Pages/Proxy-List) — so every catalog
// country is routable without manual setup. Direct routes: user.proxy_ip, or
// direct egress with anti-loop (never back into this Worker).
const PROBE_MAX = 8;
const TRY_MAX = 5;

export async function connectOutbound(env, country, user, targetHost, targetPort, workerHost) {
  let candidates = [];
  let loc = null;
  if (country) {
    loc = (await getLocations(env)).find((x) => String(x.code || "").toLowerCase() === String(country).toLowerCase()) || null;
    candidates = await rankCountryProxies(loc);
    const settings = await getSettings(env);
    if (settings.catalogRouting) {
      const catProxies = await getCatalogCountryProxies(env, country);
      for (const p of catProxies) {
        if (!candidates.includes(p.entry)) candidates.push(p.entry);
      }
    }
    if (!candidates.length) return null;
  } else {
    candidates = [String(user.proxy_ip || "").trim()].filter(Boolean);
  }
  let tried = 0;
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
    const fresh = await rankCountryProxies(loc);
    const rest = fresh.filter((e) => !candidates.slice(0, tried).includes(e));
    for (const entry of rest) {
      if (tried >= TRY_MAX * 2) break;
      tried++;
      const conn = await connectViaProxy(entry, targetHost, targetPort, loc);
      if (conn) return conn;
    }
  }
  // No route configured: direct connection, but never loop back into the
  // Worker itself (the client commonly targets the Worker domain).
  const target = String(targetHost || "").toLowerCase();
  if (target && target !== String(workerHost || "").toLowerCase()) {
    return openSocket(target, targetPort);
  }
  return null;
}

// ── Config generation ────────────────────────────────────────────────────
// Server-side generation: worker domain + CDN/clean-IP hosts × TLS ports ×
// user countries (+ the direct path). End users just refresh their sub link —
// proxy/CDN/port changes flow into the configs automatically.
const CONFIG_CAP = 200;
const CLEAN_IP_DEFAULTS = [
  "131.0.75.219", "141.101.75.29", "103.31.7.68", "103.22.200.13",
  "190.93.247.3", "173.245.58.131", "104.25.185.250", "197.234.241.21",
  "172.67.179.36", "172.64.24.33", "103.31.4.252", "198.41.211.232",
  "173.245.62.204", "172.67.194.200", "188.114.99.255", "172.64.140.35",
  "162.158.27.7", "198.41.132.22", "197.234.243.16", "108.162.239.41",
];

export async function nodesForUser(env, u, domain, settings) {
  const s = normalizeSettings(settings);
  const countries = Array.isArray(u.countries) && u.countries.length ? u.countries : [""];
  const hosts = [domain].concat(s.cdnHosts).slice(0, 3);
  const nodes = [];
  for (const code of countries) {
    const path = code ? "/route/" + encodeURIComponent(String(code).toLowerCase()) : "/" + u.uuid;
    const label = (u.remark || "user") + (code ? "-" + String(code).toUpperCase() : "");
    const ports = s.ports.slice(0, 2);
    for (const host of hosts) {
      for (const port of ports) {
        nodes.push({
          tag: label + "-" + (host === domain ? "work" : "cdn") + ":" + port,
          uuid: u.uuid,
          address: host,
          port,
          host,
          path,
          earlyData: 2048,
          country: code || "",
        });
      }
    }
  }
  // 20 clean IPs (client → CF edge on IP, SNI/Host = worker domain) so DPI
  // blocks of the workers.dev hostname don't take the whole sub down.
  for (const ip of CLEAN_IP_DEFAULTS) {
    nodes.push({
      tag: "CleanIP-" + ip,
      uuid: u.uuid,
      address: ip,
      port: 443,
      host: domain,
      path: "/" + u.uuid,
      earlyData: 2048,
      country: "",
    });
  }
  return nodes.slice(0, CONFIG_CAP);
}

function vlessLink(node, fragment) {
  const q = "encryption=none&security=tls&sni=" + encodeURIComponent(node.host) +
    "&host=" + encodeURIComponent(node.host) + "&fp=chrome&type=ws&path=" +
    encodeURIComponent(node.path + "?ed=" + node.earlyData) +
    (fragment ? "&fragment=tlshello,100-200,10-20" : "");
  return "vless://" + node.uuid + "@" + node.address + ":" + node.port + "?" + q +
    "#" + encodeURIComponent(node.tag);
}

export async function vlessConfigsForUser(env, u, domain, settings) {
  const nodes = await nodesForUser(env, u, domain, settings);
  const frag = normalizeSettings(settings).fragment;
  return nodes.map((n) => vlessLink(n, frag));
}

// ── sing-box template conversion ───────────────────────────────────────────
// Mirrors the structure of the reference template the user pointed at: fakeip
// DNS + rule-based servers, mixed + tun inbounds, per-service selector groups
// that all fall back to the main selector, one VLESS outbound per node with
// ws transport + 0-RTT early data + randomized uTLS, urltest groups per country.
function singboxOutbound(node) {
  const out = {
    type: "vless",
    tag: node.tag,
    server: node.address,
    server_port: node.port,
    uuid: node.uuid,
    tls: {
      enabled: true,
      server_name: node.host,
      insecure: false,
      utls: { enabled: true, fingerprint: "randomized" },
    },
    transport: {
      type: "ws",
      path: node.path + "?ed=" + node.earlyData,
      headers: { Host: node.host },
      max_early_data: node.earlyData,
      early_data_header_name: "Sec-WebSocket-Protocol",
    },
  };
  return out;
}

export async function singboxConfigForUsers(env, users, domain, settings) {
  const nodeLists = await Promise.all(users.map((u) => nodesForUser(env, u, domain, settings)));
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
  for (const n of nodes) outbounds.push(singboxOutbound(n));

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
        { tag: "remote", address: "https://223.5.5.5/dns-query", detour: "select" },
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
