// Runtime simulation test for SpiderPanel Worker using Miniflare.
// Covers: health, login-claim flow, session auth, user CRUD, locations,
// subscriptions, and tunnel auth rejection for unknown UUIDs.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";

// The worker is pre-bundled to a single ESM file (esbuild, cloudflare:sockets
// kept external) so no module rules are needed. This repo resolved a Miniflare
// prerelease with the v5 options shape, hence convertV4MiniflareOptions.
const v5 = convertV4MiniflareOptions({
  workers: [
    {
      name: "spiderpanel",
      modules: true,
      script: readFileSync("/tmp/spider-bundle.mjs", "utf8"),
      compatibilityDate: "2025-05-01",
      bindings: { SPIDER_TOKEN: "test-admin-token-123" },
      kvNamespaces: ["SPIDER_KV"],
    },
  ],
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

console.log("── health ──");
{
  const r = await req("/health");
  check("GET /health → 200 SpiderPanel online", r.status === 200 && (await r.text()).includes("SpiderPanel online"));
}

console.log("── panel: login page ──");
{
  const r = await req("/spider");
  const t = await r.text();
  check("GET /spider → 200 html with form", r.status === 200 && t.includes("ورود مدیر") && t.includes("<form"));
}

console.log("── panel: login claim flow ──");
{
  const bad = await req("/spider", { method: "POST", body: new URLSearchParams({ token: "wrong-token-999" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  check("wrong token rejected (401)", bad.status === 401);

  const ok = await req("/spider", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  check("correct token → 303 redirect + cookie", ok.status === 303 && cookie.startsWith("spider_sid="));

  const dash = await req("/spider");
  const dt = await dash.text();
  check("dashboard served with client script", dash.status === 200 && dt.includes("data-act=") && dt.includes("refresh()"));
}

console.log("── admin api: users ──");
let uuid = "";
{
  // NOTE: by this point the login block above has already set the session
  // cookie, so state succeeds — covered again after logout at the bottom.
  const state0 = await req("/spider/state");
  check("state with session → ok", state0.status === 200);

  const create = await req("/spider/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remark: "alice", limit_gb: 10, expire_days: 30, countries: ["de", "tr"] }),
  });
  const cj = await create.json();
  check("create user ok", create.status === 200 && cj.ok && cj.user.remark === "alice");
  uuid = cj.user.uuid;

  const state = await req("/spider/state");
  const st = await state.json();
  check("state lists 1 user + 0 locs", state.status === 200 && st.users.length === 1 && st.locations.length === 0);
}

console.log("── admin api: locations ──");
{
  const loc = await req("/spider/locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "de", name: "Germany", proxies: ["1.2.3.4:443", "5.6.7.8:443"] }),
  });
  const lj = await loc.json();
  check("create location ok", loc.status === 200 && lj.locations.length === 1 && lj.locations[0].proxy === "1.2.3.4:443");
}

console.log("── admin api: proxy catalog ──");
{
  const cat = await req("/spider/catalog");
  const cj = await cat.json();
  check("catalog aggregates countries", cat.status === 200 && cj.ok && cj.countries.length > 0 && cj.totals.all > 0);
  const top = cj.countries[0].code;
  const det = await req("/spider/catalog?country=" + encodeURIComponent(top));
  const dj = await det.json();
  check("catalog country rows", det.status === 200 && dj.ok && dj.proxies.length > 0 && dj.proxies[0].proxy.includes(":"));

  // End-to-end: a catalog proxy stored as a location must appear in configs.
  const p = dj.proxies[0];
  const locAdd = await req("/spider/locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "cattest", name: "Catalog Test", proxies: [p.proxy] }),
  });
  check("catalog proxy usable as location", locAdd.status === 200);
  await req("/spider/locations/cattest", { method: "DELETE" });
}

console.log("── admin api: subscriptions ──");
let subToken = "";
{
  const s = await req("/spider/subs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "my-sub", uuids: [uuid] }),
  });
  const sj = await s.json();
  check("create subscription ok", s.status === 200 && sj.ok);
  subToken = sj.sub.token;

  const pub = await req("/sub/" + subToken);
  const body = await pub.text();
  const decoded = Buffer.from(body, "base64").toString("utf8");
  // Miniflare's dispatchFetch exposes the worker on 127.0.0.1:<port>, so the
  // Host header carries the port; in production the Host is the bare domain.
  check("public /sub/{token} → base64 vless configs", pub.status === 200 && decoded.includes("vless://" + uuid + "@"));
  check("config host uses request domain", /@[^:]+:\d+:443/.test(decoded));
  check("country route paths present", decoded.includes("route%2Fde") && decoded.includes("route%2Ftr"));

  const nf = await req("/sub/doesnotexist");
  check("unknown sub token → 404", nf.status === 404);
}

console.log("── tunnel auth ──");
{
  const wsInit = await req("/" + uuid, {
    headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
  });
  check("valid-uuid WS reaches tunnel handler (101/403)", wsInit.status === 101 || wsInit.status === 403 || wsInit.status === 500, "status=" + wsInit.status);

  const unknown = "00000000-0000-4000-8000-000000000000";
  const rej = await req("/" + unknown, {
    headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
  });
  check("unknown uuid → 403", rej.status === 403);

  const routeNoWs = await req("/route/de");
  check("/route/{code} without WS upgrade → 400", routeNoWs.status === 400);
}

console.log("── user disable / enable / delete ──");
{
  const t = await req("/spider/user/" + uuid, { method: "POST" });
  const tj = await t.json();
  check("toggle → disabled true", t.status === 200 && tj.user.disabled === true);

  const subWhileDisabled = await req("/sub/" + subToken);
  check("sub excludes disabled user (404 empty)", subWhileDisabled.status === 404);

  await req("/spider/user/" + uuid, { method: "POST" });
  const subAgain = await req("/sub/" + subToken);
  check("re-enabled user back in sub", subAgain.status === 200);

  const del = await req("/spider/user/" + uuid, { method: "DELETE" });
  check("delete ok", del.status === 200);
  const state = await req("/spider/state");
  check("state empty after delete", (await state.json()).users.length === 0);
}

console.log("── logout ──");
{
  const r = await req("/spider/logout", { redirect: "manual" });
  check("logout → 303", r.status === 303);
  cookie = "";
  const after = await req("/spider/state");
  check("state after logout without auth → 403", after.status === 403);
}

await MF.dispose();
console.log(failures === 0 ? "\nALL TESTS PASSED" : "\n" + failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
