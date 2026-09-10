// SpiderPanel — Panel UI + Admin API + Subscription (Cloudflare Workers)
// ══════════════════════════════════════════════════════════════════════════════
// Auth model:
//   • First login claims the admin token (or SPIDER_TOKEN var, if preset).
//   • After login a session cookie (spider_sid, HttpOnly, 24h) is issued and
//     stored in KV; the dashboard uses the cookie — the token never touches
//     page JS.
//   • The JSON API also accepts "Authorization: Bearer <adminToken>" for
//     scripts / external clients.
//
// The dashboard client script lives in src/dashboard.txt, imported as a Text
// module (wrangler.jsonc rules) — no string-escaping gymnastics.
// ══════════════════════════════════════════════════════════════════════════════

import {
  UUID_RE, nowSec, randomToken, randomUuid, sha256Hex, timingSafeEq,
  getSetup, saveSetup, getUser, getUserRaw, saveUser, listUsers,
  getLocations, saveLocations, vlessConfigsForUser, singboxConfigForUsers, clashConfigForUsers, getSettings, saveSettings,
  parseEndpoint, probeTcpEndpoint,
} from "./tunnel.js";
import { handleCatalog } from "./catalog.js";
import dashboardJs from "./dashboard.txt";

export const PANEL_PATH = "/spider";
const SESSION_TTL = 86400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function parseCookies(request) {
  const h = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(name, value, maxAge) {
  const parts = [name + "=" + value, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge > 0) parts.push("Max-Age=" + maxAge);
  return parts.join("; ");
}

async function sessionValid(request, env) {
  const sid = parseCookies(request).spider_sid;
  if (!sid) return false;
  try { return !!(await env.SPIDER_KV.get("sess:" + sid)); } catch { return false; }
}

async function bearerValid(request, env, url) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  const setup = await getSetup(env);
  if (!setup) return false;
  return timingSafeEq(await sha256Hex(h.slice(7).trim()), await sha256Hex(setup.adminToken));
}

async function isAdmin(request, env, url) {
  return (await sessionValid(request, env)) || (await bearerValid(request, env, url));
}

// ── Subscription (public) ─────────────────────────────────────────────────
// Default: base64 VLESS link list (v2ray/xray/hiddify). The target query
// supports sing-box and Clash; User-Agent detection makes normal client
// subscription imports work without a manually chosen query string.
export async function handleSubscription(request, env, url, token) {
  token = decodeURIComponent(token || "");
  let sub = null;
  try { sub = JSON.parse((await env.SPIDER_KV.get("sub:" + token)) || "null"); } catch { sub = null; }
  if (!sub) return new Response("Not Found", { status: 404 });
  if (sub.expire && nowSec() > sub.expire) return new Response("Expired", { status: 410 });
  const host = (request.headers.get("host") || "").trim();
  if (!host) return new Response("Bad host", { status: 500 });
  const settings = await getSettings(env);
  const domain = host.split(":")[0];
  const explicitTarget = (url.searchParams.get("target") || "").toLowerCase();
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const target = explicitTarget || (ua.includes("sing-box") || ua.includes("singbox") ? "singbox" :
    (ua.includes("clash") || ua.includes("stash") || ua.includes("mihomo") ? "clash" : ""));
  const users = [];
  let used = 0, limit = 0;
  for (const uuid of sub.uuids || []) {
    const u = await getUser(env, uuid);
    if (!u) continue;
    users.push(u);
    used += u.used_bytes || 0;
    if (u.limit_bytes > 0) limit += u.limit_bytes;
  }
  const info = {
    "subscription-userinfo": "upload=0; download=" + used + "; total=" + limit + "; expire=" + (sub.expire || 0),
    "profile-update-interval": "2",
  };

  if (target === "singbox" || target === "clash") {
    if (!users.length) return new Response("No active configs", { status: 404 });
    if (target === "singbox") {
      const cfg = await singboxConfigForUsers(env, users, domain, settings);
      return new Response(JSON.stringify(cfg, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...info },
      });
    }
    const yaml = await clashConfigForUsers(env, users, domain, settings);
    return new Response(yaml, {
      headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store", ...info },
    });
  }

  const lines = [];
  for (const u of users) {
    for (const c of await vlessConfigsForUser(env, u, domain, settings)) lines.push(c);
  }
  if (!lines.length) return new Response("No active configs", { status: 404 });
  const bytes = new TextEncoder().encode(lines.join("\n"));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return new Response(btoa(bin), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...info },
  });
}

// ── Panel routes ─────────────────────────────────────────────────────────────
export async function handlePanel(request, env, url) {
  const method = request.method;
  const sub = url.pathname.slice(PANEL_PATH.length) || "/";

  // Login page / login POST
  if (sub === "/" || sub === "") {
    if (method === "POST") {
      const form = await request.formData().catch(() => null);
      const token = String((form && form.get("token")) || "").trim();
      if (token.length < 8) return html(loginPage("توکن باید حداقل ۸ کاراکتر باشد"), 401);
      let setup = await getSetup(env);
      if (!setup) {
        // First login claims the admin token (SPIDER_TOKEN wins if preset).
        setup = { adminToken: env.SPIDER_TOKEN || token, panelPath: PANEL_PATH, createdAt: nowSec() };
        await saveSetup(env, setup);
      }
      if (!timingSafeEq(await sha256Hex(token), await sha256Hex(setup.adminToken))) {
        return html(loginPage("توکن نادرست است"), 401);
      }
      const sid = randomToken();
      await env.SPIDER_KV.put("sess:" + sid, JSON.stringify({ at: nowSec() }), { expirationTtl: SESSION_TTL });
      return new Response(null, {
        status: 303,
        headers: { location: PANEL_PATH, "set-cookie": cookieHeader("spider_sid", sid, SESSION_TTL) },
      });
    }
    if (await sessionValid(request, env)) return html(dashPage());
    return html(loginPage(""));
  }

  if (sub === "/logout") {
    const sid = parseCookies(request).spider_sid;
    if (sid) { try { await env.SPIDER_KV.delete("sess:" + sid); } catch { /* ignore */ } }
    return new Response(null, {
      status: 303,
      headers: { location: PANEL_PATH, "set-cookie": cookieHeader("spider_sid", "", 0) },
    });
  }

  // Everything below is the admin JSON API.
  if (!(await isAdmin(request, env, url))) return json({ error: "Forbidden" }, 403);

  if (sub === "/state" && method === "GET") {
    const subs = [];
    const list = await env.SPIDER_KV.list({ prefix: "sub:" });
    for (const k of list.keys) {
      try { const s = JSON.parse(await env.SPIDER_KV.get(k.name)); if (s) subs.push(s); } catch { /* skip */ }
    }
    return json({ ok: true, users: await listUsers(env), locations: await getLocations(env), subs, settings: await getSettings(env) });
  }

  if (sub === "/settings" && method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur = await getSettings(env);
    const next = {
      catalogRouting: typeof b.catalogRouting === "boolean" ? b.catalogRouting : cur.catalogRouting,
      cdnHosts: Array.isArray(b.cdnHosts) ? b.cdnHosts.map((x) => String(x).trim()).filter(Boolean) : cur.cdnHosts,
      cleanIps: Array.isArray(b.cleanIps) ? b.cleanIps.map((x) => String(x).trim()).filter(Boolean) : cur.cleanIps,
      ports: Array.isArray(b.ports) ? b.ports.map(Number).filter((p) => p > 0 && p < 65536) : cur.ports,
      fragment: typeof b.fragment === "boolean" ? b.fragment : cur.fragment,
      outboundMode: ["proxy-first", "direct-first", "proxy-only"].includes(b.outboundMode) ? b.outboundMode : cur.outboundMode,
      ech: typeof b.ech === "boolean" ? b.ech : cur.ech,
      alpn: Array.isArray(b.alpn) ? b.alpn : cur.alpn,
    };
    await saveSettings(env, next);
    return json({ ok: true, settings: await getSettings(env) });
  }

  if (sub === "/latency" && method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const raw = Array.isArray(b.targets) ? b.targets : String(b.targets || "").split(/[\s,]+/);
    const targets = raw.map((x) => parseEndpoint(x, Number(b.port) || 443)).filter(Boolean).slice(0, 50);
    const results = await Promise.all(targets.map(async (target) => {
      const result = await probeTcpEndpoint(target.host, target.port, 3500);
      return { host: target.host, port: target.port, ok: result.ok, ms: result.ms };
    }));
    results.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.ms - b.ms));
    return json({ ok: true, results });
  }

  // Server-side link generation for one user (CDN hosts × ports × countries).
  if (sub.startsWith("/links/") && method === "GET") {
    const uuid = decodeURIComponent(sub.slice("/links/".length)).toLowerCase();
    const u = await getUserRaw(env, uuid);
    if (!u) return json({ error: "not found" }, 404);
    const host = (request.headers.get("host") || "").split(":")[0];
    const configs = await vlessConfigsForUser(env, u, host, await getSettings(env));
    return json({ ok: true, configs });
  }

  if (sub === "/users" && method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let uuid = String(b.uuid || "").toLowerCase().trim();
    if (uuid && !UUID_RE.test(uuid)) return json({ error: "bad uuid" }, 400);
    if (!uuid) uuid = randomUuid();
    const existing = await getUserRaw(env, uuid);
    const now = nowSec();
    const u = {
      uuid,
      remark: String(b.remark || "user").slice(0, 64),
      limit_bytes: Math.round((Number(b.limit_gb) || 0) * 1073741824),
      expire: Number(b.expire_days) > 0 ? now + Number(b.expire_days) * 86400 : 0,
      used_bytes: existing ? existing.used_bytes || 0 : 0,
      proxy_ip: String(b.proxy_ip || "").trim(),
      concurrent_connections: Number(b.concurrent_connections) || 0,
      countries: Array.isArray(b.countries)
        ? b.countries.map((x) => String(x).toLowerCase().trim()).filter(Boolean)
        : [],
      disabled: existing ? !!existing.disabled : false,
      created: existing ? existing.created : now,
    };
    await saveUser(env, u);
    return json({ ok: true, user: u });
  }

  if (sub.startsWith("/user/")) {
    const uuid = sub.slice("/user/".length).toLowerCase();
    if (method === "DELETE") {
      await env.SPIDER_KV.delete("user:" + uuid);
      await env.SPIDER_KV.delete("ips:" + uuid);
      return json({ ok: true });
    }
    if (method === "POST") { // toggle enable/disable
      const u = await getUserRaw(env, uuid);
      if (!u) return json({ error: "not found" }, 404);
      u.disabled = !u.disabled;
      await saveUser(env, u);
      return json({ ok: true, user: u });
    }
  }

  if (sub === "/locations" && method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const code = String(b.code || "").toLowerCase().trim();
    if (!code) return json({ error: "code required" }, 400);
    const proxies = (Array.isArray(b.proxies) ? b.proxies : []).map((p) => String(p).trim()).filter(Boolean);
    const locs = (await getLocations(env)).filter((l) => l.code !== code);
    locs.push({ code, name: String(b.name || ""), proxy: proxies[0] || "", proxies: proxies.slice(1), port: Number(b.port) || undefined });
    await saveLocations(env, locs);
    return json({ ok: true, locations: locs });
  }

  // Live proxy catalog from EDT-Pages/Proxy-List (aggregated per country).
  if (sub === "/catalog" && method === "GET") {
    return handleCatalog(request, env, url);
  }

  if (sub.startsWith("/locations/") && method === "DELETE") {
    const code = decodeURIComponent(sub.slice("/locations/".length)).toLowerCase();
    await saveLocations(env, (await getLocations(env)).filter((l) => l.code !== code));
    return json({ ok: true });
  }

  if (sub === "/subs" && method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const subToken = randomToken();
    const rec = {
      token: subToken,
      name: String(b.name || "sub").slice(0, 64),
      uuids: (Array.isArray(b.uuids) ? b.uuids : []).map(String),
      expire: Number(b.expire_days) > 0 ? nowSec() + Number(b.expire_days) * 86400 : 0,
      created: nowSec(),
    };
    await env.SPIDER_KV.put("sub:" + subToken, JSON.stringify(rec));
    return json({ ok: true, sub: rec });
  }

  if (sub.startsWith("/subs/") && method === "DELETE") {
    await env.SPIDER_KV.delete("sub:" + decodeURIComponent(sub.slice("/subs/".length)));
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}

// ── Pages ────────────────────────────────────────────────────────────────────
function shellCss() {
  return '<style>' +
    ':root{--bg:#070d1a;--card:#101a2e;--card2:#0c1424;--line:#1e2c47;--txt:#e9f0fd;--mut:#8fa3c4;--acc:#22d3ee;--acc2:#34d399;--warn:#fbbf24;--dan:#f87171}' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:Vazirmatn,Tahoma,sans-serif;background:radial-gradient(1100px 500px at 85% -10%,#152947 0%,transparent 60%),radial-gradient(900px 500px at -10% 110%,#0e2a33 0%,transparent 55%),var(--bg);color:var(--txt);min-height:100vh}' +
    '.wrap{max-width:1180px;margin:0 auto;padding:24px 16px 70px}' +
    'header{display:flex;align-items:center;gap:12px;padding:6px 0 20px}' +
    '.logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#22d3ee2e,#34d3992e);display:flex;align-items:center;justify-content:center;font-size:25px;border:1px solid var(--line);box-shadow:0 0 24px #22d3ee22}' +
    'h1{font-size:20px;font-weight:800}h2{font-size:16px;margin-bottom:12px}h3{font-size:13px;margin-bottom:8px;color:var(--mut)}' +
    '.sub{color:var(--mut);font-size:12px}' +
    '.card{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:14px}' +
    '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}' +
    '.stat{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:14px 16px}' +
    '.stat b{display:block;font-size:22px;font-weight:800;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}' +
    '.stat span{font-size:11px;color:var(--mut)}' +
    'label{display:block;font-size:12px;color:var(--mut);margin:10px 0 5px}' +
    'input,select,textarea{width:100%;background:#0a1220;border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit}' +
    'input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px #22d3ee22}' +
    'button{background:linear-gradient(135deg,#22d3ee,#34d399);color:#04121f;border:0;border-radius:10px;padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;transition:filter .15s,transform .05s}' +
    'button:hover{filter:brightness(1.12)}button:active{transform:scale(.97)}' +
    'button.ghost{background:#141f38;color:var(--txt)}' +
    'button.danger{background:#2b1420;color:var(--dan)}' +
    'button.small{padding:6px 11px;font-size:12px}' +
    'button.wfull{width:100%;margin-top:14px}' +
    '.msg{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:13px}' +
    '.msg.err{background:#2b1420;color:var(--dan)}' +
    '.msg.ok{background:#0f2e26;color:#6ee7b7}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}' +
    'th{text-align:right;color:var(--mut);font-weight:600;padding:8px;border-bottom:1px solid var(--line);white-space:nowrap}' +
    'td{padding:10px 8px;border-bottom:1px solid #16203a}' +
    'tr:hover td{background:#131e35}' +
    '.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11px}' +
    '.pill.ok{background:#0f2e26;color:#6ee7b7}.pill.off{background:#2b1420;color:var(--dan)}.pill.warn{background:#2b2110;color:var(--warn)}.pill.info{background:#0e2733;color:#67e8f9}' +
    '.muted{color:var(--mut);font-size:12px}' +
    '.actions{display:flex;gap:6px;flex-wrap:wrap}' +
    '.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap}' +
    '.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}' +
    'dialog{background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:16px;padding:22px;max-width:680px;width:92%}' +
    'dialog::backdrop{background:rgba(3,8,18,.75);backdrop-filter:blur(3px)}' +
    '.kv{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    'a{color:var(--acc);text-decoration:none;font-size:13px}' +
    'code{background:#0a1220;padding:2px 6px;border-radius:6px;font-size:12px;direction:ltr;display:inline-block}' +
    '.ltr{direction:ltr;text-align:left}' +
    '.tbwrap{padding:0;overflow-x:auto}' +
    '.cfg{background:#0a1220;border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px;font-size:11px;word-break:break-all}' +
    '.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}' +
    '.ccard{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:12px;cursor:pointer;transition:border-color .15s,transform .05s}' +
    '.ccard:hover{border-color:var(--acc);transform:translateY(-1px)}' +
    '.ccard .fl{font-size:22px;line-height:1}' +
    '.ccard .nm{font-size:12px;margin-top:6px;font-weight:700}' +
    '.ccard .ct{font-size:11px;color:var(--mut);margin-top:2px}' +
    '.proto{display:flex;gap:4px;margin-top:8px;flex-wrap:wrap}' +
    '.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(12px);background:#0f2e26;color:#6ee7b7;border:1px solid #1a4a3a;padding:10px 18px;border-radius:12px;font-size:13px;opacity:0;transition:all .25s;z-index:99;box-shadow:0 8px 30px #0008}' +
    '.toast.in{opacity:1;transform:translateX(-50%) translateY(0)}' +
    '.toast.bad{background:#2b1420;color:var(--dan);border-color:#4a1a2a}' +
    '</style>';
}

function shellHead(title) {
  return '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">' +
    shellCss();
}

function shellBrand(subtitle) {
  return '<header><div class="logo">🕷️</div><div><h1>SpiderPanel</h1>' +
    '<div class="sub">' + subtitle + '</div></div>' +
    '<a href="' + PANEL_PATH + '/logout" style="margin-inline-start:auto">خروج</a></header>';
}

function loginPage(error) {
  return '<!doctype html><html lang="fa" dir="rtl"><head>' + shellHead("SpiderPanel — ورود") + '</head><body>' +
    '<div class="wrap" style="max-width:420px">' +
    shellBrand("پنل مدیریت اتصالات بر بستر Cloudflare Workers") +
    '<div class="card"><h2>ورود مدیر</h2>' +
    (error ? '<div class="msg err">' + error + '</div>' : '') +
    '<form method="post" action="' + PANEL_PATH + '">' +
    '<label>توکن مدیریت</label>' +
    '<input type="password" name="token" placeholder="Admin token" autofocus autocomplete="current-password">' +
    '<button type="submit" class="wfull">ورود به پنل</button></form>' +
    '<p class="muted" style="margin-top:14px">اولین توکنی که با آن وارد شوید، توکن مدیریت پنل را ثبت می‌کند. آن را ایمن نگه دارید.</p>' +
    '</div></div></body></html>';
}

function dashPage() {
  return '<!doctype html><html lang="fa" dir="rtl"><head>' + shellHead("SpiderPanel — داشبورد") + '</head><body>' +
    '<div class="wrap">' +
    shellBrand("پنل مدیریت اتصالات بر بستر Cloudflare Workers") +
    '<div class="tabs">' +
    '<button class="small ghost" data-act="tab" data-arg="users">کاربران</button>' +
    '<button class="small ghost" data-act="tab" data-arg="locs">لوکیشن‌ها</button>' +
    '<button class="small ghost" data-act="tab" data-arg="catalog">کاتالوگ زنده</button>' +
    '<button class="small ghost" data-act="tab" data-arg="latency">تست IP</button>' +
    '<button class="small ghost" data-act="tab" data-arg="subs">اشتراک‌ها</button>' +
    '<button class="small ghost" data-act="tab" data-arg="settings">تنظیمات</button>' +
    '</div>' +
    '<div id="view"><div class="muted">در حال بارگذاری…</div></div>' +
    '</div>' +
    '<dialog id="dlg"></dialog>' +
    '<script>' + dashboardJs + '</script>' +
    '</body></html>';
}
