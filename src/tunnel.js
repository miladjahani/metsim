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
  pos += 1; // command byte (1 = TCP)
  const port = (data[pos] << 8) | data[pos + 1]; pos += 2;
  const atype = data[pos]; pos += 1;
  let address;
  if (atype === 1) { address = Array.from(data.slice(pos, pos + 4)).join("."); pos += 4; }
  else if (atype === 2) {
    const dlen = data[pos]; pos += 1;
    address = dec.decode(data.subarray(pos, pos + dlen)); pos += dlen;
  } else if (atype === 3) {
    const b = data.subarray(pos, pos + 16); pos += 16;
    const hex = [];
    for (let i = 0; i < 16; i += 2) hex.push(((b[i] << 8) | b[i + 1]).toString(16));
    address = hex.join(":");
  } else return null;
  return { userId, address, port, payload: data.subarray(pos) };
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
export async function getSettings(env) {
  try {
    const s = JSON.parse((await env.SPIDER_KV.get("spider:settings")) || "null");
    return { catalogRouting: !s || s.catalogRouting !== false };
  } catch { return { catalogRouting: true }; }
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

// ── Config generation ────────────────────────────────────────────────────────
export function vlessConfigsForUser(u, domain) {
  const out = [];
  const countries = Array.isArray(u.countries) && u.countries.length ? u.countries : [""];
  for (const code of countries) {
    const path = code ? "/route/" + encodeURIComponent(String(code).toLowerCase()) : "/" + u.uuid;
    const remark = (u.remark || "user") + (code ? " " + String(code).toUpperCase() : "");
    const q = "encryption=none&security=tls&sni=" + encodeURIComponent(domain) +
      "&host=" + encodeURIComponent(domain) + "&fp=chrome&type=ws&path=" + encodeURIComponent(path);
    out.push("vless://" + u.uuid + "@" + domain + ":443?" + q + "#" + encodeURIComponent(remark));
  }
  return out;
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

  server.addEventListener("message", async (ev) => {
    const data = new Uint8Array(ev.data);
    if (!server.__h) {
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
