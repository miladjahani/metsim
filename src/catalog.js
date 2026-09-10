// SpiderPanel — Live proxy catalog (EDT-Pages/Proxy-List)
// ══════════════════════════════════════════════════════════════════════════════
// Catalog countries ARE locations: any country present in the upstream lists
// can be routed through /route/{code} without manual setup — tunnel.js merges
// the live catalog rows into its outbound candidates automatically.
//
//   GET /spider/catalog              → totals + per-country aggregation
//   GET /spider/catalog?country=DE   → proxy rows for one country
//   GET /spider/catalog?country=DE&proto=socks5
//   ...&refresh=1                    → force re-fetch
//
// Caching: in-isolate memo first, then KV (10 min TTL) so cold isolates don't
// hammer GitHub. Per-country rows are capped (top 150 by list order).
// ══════════════════════════════════════════════════════════════════════════════

import { nowSec } from "./tunnel.js";

const SOURCES = [
  { proto: "http", url: "https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/http.json" },
  { proto: "https", url: "https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/https.json" },
  { proto: "socks5", url: "https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/socks5.json" },
];

const CACHE_KEY = "catalog:edt:v1";
const CACHE_TTL = 600; // seconds
const PER_COUNTRY_CAP = 150;
const ROWS_CAP = 250;

const mem = { at: 0, data: null };

function pick(v) { return v == null ? "" : String(v); }

async function fetchSource(src) {
  try {
    const res = await fetch(src.url, { headers: { "user-agent": "SpiderPanel/1.0" }, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) return [];
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => ({
      proxy: pick(e.proxy),
      ip: pick(e.ip),
      port: Number(e.port) || 0,
      proto: src.proto,
      country: pick(e.country).toUpperCase().slice(0, 2),
      city: pick(e.city),
      aso: pick(e.asOrganization),
      emoji: pick(e.country_emoji),
      name: pick(e.country_en),
    })).filter((p) => p.proxy && p.country);
  } catch {
    return [];
  }
}

async function fetchAll() {
  const lists = await Promise.all(SOURCES.map(fetchSource));
  const totals = { http: lists[0].length, https: lists[1].length, socks5: lists[2].length, all: 0 };
  totals.all = totals.http + totals.https + totals.socks5;

  const countries = new Map(); // code → agg
  const byCountry = new Map(); // code → [rows]
  for (const list of lists) {
    for (const p of list) {
      let c = countries.get(p.country);
      if (!c) {
        c = { code: p.country, emoji: "", name: "", http: 0, https: 0, socks5: 0, total: 0 };
        countries.set(p.country, c);
      }
      if (!c.emoji && p.emoji) c.emoji = p.emoji;
      if (!c.name && p.name) c.name = p.name;
      c[p.proto]++;
      c.total++;
      let rows = byCountry.get(p.country);
      if (!rows) { rows = []; byCountry.set(p.country, rows); }
      if (rows.length < PER_COUNTRY_CAP) {
        rows.push({ proxy: p.proxy, proto: p.proto, ip: p.ip, port: p.port, city: p.city, aso: p.aso });
      }
    }
  }

  return {
    at: nowSec(),
    totals,
    countries: [...countries.values()].sort((a, b) => b.total - a.total),
    byCountry: Object.fromEntries(byCountry),
  };
}

export async function getCatalog(env, force) {
  const now = nowSec();
  if (!force && mem.data && now - mem.at < CACHE_TTL) return mem.data;
  if (!force) {
    try {
      const raw = await env.SPIDER_KV.get(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && nowSec() - c.at < CACHE_TTL) { mem.at = c.at; mem.data = c.data; return mem.data; }
      }
    } catch { /* fall through to fetch */ }
  }
  const data = await fetchAll();
  mem.at = nowSec();
  mem.data = data;
  try { await env.SPIDER_KV.put(CACHE_KEY, JSON.stringify({ at: mem.at, data }), { expirationTtl: CACHE_TTL * 2 }); } catch { /* best effort */ }
  return data;
}

// Ordered proxy entries for a country: socks5 → https → http (most capable
// first). Used by both the panel API and the tunnel's outbound resolution.
export async function getCatalogCountryProxies(env, code) {
  const cat = await getCatalog(env, false);
  const rows = cat.byCountry[String(code || "").toUpperCase()] || [];
  const rank = { socks5: 0, https: 1, http: 2 };
  return rows
    .map((r) => ({ entry: r.proxy, proto: r.proto }))
    .sort((a, b) => (rank[a.proto] ?? 9) - (rank[b.proto] ?? 9));
}

export async function handleCatalog(request, env, url) {
  const force = url.searchParams.get("refresh") === "1";
  let cat;
  try { cat = await getCatalog(env, force); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: "catalog fetch failed: " + (e && e.message) }), { status: 502, headers: { "content-type": "application/json" } }); }

  const country = (url.searchParams.get("country") || "").trim().toUpperCase().slice(0, 2);
  const proto = (url.searchParams.get("proto") || "").trim().toLowerCase();

  if (country) {
    const rows = ((cat.byCountry[country] || [])).filter((p) => !proto || p.proto === proto).slice(0, ROWS_CAP);
    return new Response(JSON.stringify({ ok: true, country, count: rows.length, proxies: rows }), { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  const countries = cat.countries.map((c) => ({ ...c }));
  return new Response(JSON.stringify({
    ok: true,
    source: "EDT-Pages/Proxy-List",
    updated: cat.at,
    totals: cat.totals,
    countries,
  }), { headers: { "content-type": "application/json; charset=utf-8" } });
}
