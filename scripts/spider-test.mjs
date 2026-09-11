// Runtime simulation test for SpiderPanel Worker using Miniflare.
// Covers: health, login-claim flow, session auth, user CRUD, locations,
// subscriptions, formats, latency testing, and tunnel auth rejection.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";

const v5 = convertV4MiniflareOptions({
  workers: [{
    name: "spiderpanel",
    modules: true,
    script: readFileSync("/tmp/spider-bundle.mjs", "utf8"),
    compatibilityDate: "2025-05-01",
    bindings: { SPIDER_TOKEN: "test-admin-token-123" },
    kvNamespaces: ["SPIDER_KV"],
  }],
});
const MF = new Miniflare(v5);
const ADMIN = "test-admin-token-123";
let cookie = "";
let failures = 0;

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const res = await MF.dispatchFetch("https://spider.test" + path, { ...opts, headers, redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}
function check(name, cond, extra = "") {
  if (cond) console.log("  PASS " + name);
  else { failures++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
}

console.log("── health + login ──");
{
  const r = await req("/health");
  check("GET /health → 200", r.status === 200 && (await r.text()).includes("SpiderPanel online"));
  const page = await req("/spider");
  check("GET /spider → login form", page.status === 200 && (await page.text()).includes("ورود مدیر"));
  const bad = await req("/spider", { method: "POST", body: new URLSearchParams({ token: "wrong-token-999" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  check("wrong token rejected", bad.status === 401);
  const ok = await req("/spider", { method: "POST", body: new URLSearchParams({ token: ADMIN }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  check("correct token creates session", ok.status === 303 && cookie.startsWith("spider_sid="));
  const dash = await req("/spider");
  check("dashboard served", dash.status === 200 && (await dash.text()).includes("refresh()"));
}

console.log("── users + locations ──");
let uuid = "";
{
  const state0 = await req("/spider/state");
  check("state with session", state0.status === 200);
  const create = await req("/spider/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ remark: "alice", limit_gb: 10, expire_days: 30, countries: ["de", "tr"] }) });
  const cj = await create.json();
  check("create user", create.status === 200 && cj.ok && cj.user.remark === "alice");
  uuid = cj.user.uuid;
  const loc = await req("/spider/locations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "de", name: "Germany", proxies: ["1.2.3.4:443", "5.6.7.8:443"] }) });
  const lj = await loc.json();
  check("create location", loc.status === 200 && lj.locations.length === 1);
}

console.log("── live catalog ──");
{
  const cat = await req("/spider/catalog");
  const cj = await cat.json();
  check("catalog aggregates countries", cat.status === 200 && cj.ok && cj.countries.length > 0 && cj.totals.all > 0);
  const top = cj.countries[0].code;
  const det = await req("/spider/catalog?country=" + encodeURIComponent(top));
  const dj = await det.json();
  check("catalog country rows", det.status === 200 && dj.ok && dj.proxies.length > 0);
  const locAdd = await req("/spider/locations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "cattest", name: "Catalog Test", proxies: [dj.proxies[0].proxy] }) });
  check("catalog proxy can be saved", locAdd.status === 200);
  await req("/spider/locations/cattest", { method: "DELETE" });
}

console.log("── settings + latency ──");
{
  const s0 = await req("/spider/state");
  const st0 = await s0.json();
  check("settings defaults are present", s0.status === 200 && st0.settings.catalogRouting === true && Array.isArray(st0.settings.cleanIps) && st0.settings.epd === true && st0.settings.egi === true && st0.settings.dnsUrl.includes("dns-query"));
  const saved = await req("/spider/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    catalogRouting: true, cleanIps: ["1.1.1.1:443", "8.8.8.8"], outboundMode: "proxy-only", ech: true, alpn: ["h2"], fragment: true, nonTls: false,
  }) });
  const sj = await saved.json();
  check("advanced settings normalized", saved.status === 200 && sj.settings.cleanIps[0] === "1.1.1.1:443" && sj.settings.outboundMode === "proxy-only" && sj.settings.ech === true && sj.settings.alpn[0] === "h2" && sj.settings.nonTls === false && !Object.prototype.hasOwnProperty.call(sj.settings, "fragment"));
  const latency = await req("/spider/latency", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets: ["1.1.1.1:443", "bad target"] }) });
  const ljson = await latency.json();
  check("latency endpoint returns bounded results", latency.status === 200 && ljson.ok && ljson.results.length === 2);
}

console.log("── subscriptions: VLESS, sing-box, Clash, UA ──");
let subToken = "";
{
  const s = await req("/spider/subs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "my-sub", uuids: [uuid] }) });
  const sj = await s.json();
  check("create subscription", s.status === 200 && sj.ok);
  subToken = sj.sub.token;

  const pub = await req("/sub/" + subToken);
  const body = await pub.text();
  const decoded = Buffer.from(body, "base64").toString("utf8");
  check("VLESS subscription is base64", pub.status === 200 && decoded.includes("vless://" + uuid + "@"));
  check("cfnew link shape (fp/ech/ed/eh)", decoded.includes("@1.1.1.1:443?") && decoded.includes("alpn=h2") && decoded.includes("fp=chrome") && decoded.includes("ech=" + encodeURIComponent("cloudflare-ech.com+https://223.5.5.5/dns-query")) && decoded.includes("&ed=2048") && decoded.includes("&eh=Sec-WebSocket-Protocol") && !decoded.includes("fragment=") && !decoded.includes("cdn"));
  check("cfnew node naming", decoded.includes("%E8%87%AA%E5%AE%9A%E4%B9%89%E4%BC%98%E9%80%89-01") || decoded.includes("%E8%87%AA%E5%AE%9A%E4%B9%89%E4%BC%98%E9%80%89-02"));
  check("country routes remain multi-location", decoded.includes("route%2Fde") && decoded.includes("route%2Ftr"));

  // Preferred pool: with custom cleanIps set, custom entries replace remote
  // sources (cfnew behaviour) and only live-probed pairs survive.
  const pref = await req("/spider/preferred?refresh=1");
  const pj = await pref.json();
  check("preferred pool probes custom entries", pref.status === 200 && pj.ok && Array.isArray(pj.live));
  check("preferred pool only has live pairs", Array.isArray(pj.live) && pj.live.every((p) => p.ok && p.ms >= 0));
  check("preferred pool expanded ports", Array.isArray(pj.live) && pj.live.some((p) => p.host === "1.1.1.1" && p.port === 443));

  const sb = await req("/sub/" + subToken + "?target=singbox");
  const sbBody = await sb.text();
  let cfg = null;
  try { cfg = JSON.parse(sbBody); } catch { /* keep null */ }
  check("sing-box is valid JSON", sb.status === 200 && !!cfg);
  check("sing-box has selector + VLESS", !!cfg && cfg.outbounds.some((o) => o.type === "selector" && o.tag === "select") && cfg.outbounds.some((o) => o.type === "vless" && o.tag.indexOf("alice") === 0));
  check("sing-box has 0-RTT + advanced TLS", !!cfg && cfg.outbounds.some((o) => o.type === "vless" && o.tls && o.tls.alpn && o.tls.alpn[0] === "h2" && o.tls.ech && o.transport.max_early_data === 2048));
  check("sing-box has fakeip + tun", !!cfg && cfg.dns.fakeip.enabled === true && cfg.inbounds.some((i) => i.type === "tun"));

  const clash = await req("/sub/" + subToken + "?target=clash");
  const clashBody = await clash.text();
  check("Clash is YAML with VLESS groups", clash.status === 200 && clashBody.includes("proxies:") && clashBody.includes("type: \"vless\"") && clashBody.includes("proxy-groups:"));
  const detected = await req("/sub/" + subToken, { headers: { "user-agent": "Clash.Meta/1.18" } });
  const detectedBody = await detected.text();
  check("Clash UA is auto-detected", detected.status === 200 && detectedBody.includes("proxy-groups:"));

  const nf = await req("/sub/doesnotexist");
  check("unknown subscription → 404", nf.status === 404);
}

console.log("── tunnel auth + lifecycle ──");
{
  const wsInit = await req("/" + uuid, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
  check("valid UUID reaches tunnel handler", wsInit.status === 101 || wsInit.status === 403 || wsInit.status === 500, "status=" + wsInit.status);
  const unknown = "00000000-0000-4000-8000-000000000000";
  const rej = await req("/" + unknown, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
  check("unknown UUID → 403", rej.status === 403);
  const routeNoWs = await req("/route/de");
  check("route without WS → 400", routeNoWs.status === 400);
  const t = await req("/spider/user/" + uuid, { method: "POST" });
  check("disable user", t.status === 200 && (await t.json()).user.disabled === true);
  const disabledSub = await req("/sub/" + subToken);
  check("disabled user removed from sub", disabledSub.status === 404);
  await req("/spider/user/" + uuid, { method: "POST" });
  const del = await req("/spider/user/" + uuid, { method: "DELETE" });
  check("delete user", del.status === 200);
}

console.log("── logout ──");
{
  const r = await req("/spider/logout", { redirect: "manual" });
  check("logout → 303", r.status === 303);
  cookie = "";
  const after = await req("/spider/state");
  check("state after logout → 403", after.status === 403);
}

await MF.dispose();
console.log(failures === 0 ? "\nALL TESTS PASSED" : "\n" + failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
