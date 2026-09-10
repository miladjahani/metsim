// SpiderPanel — Cloudflare Workers Edition
// ══════════════════════════════════════════════════════════════════════════════
// Single Worker = panel + VLESS tunnel. Deployed straight from GitHub via the
// Cloudflare Workers "Connect" flow (wrangler.jsonc + auto-provisioned KV).
//
// Routes:
//   GET  /health            → liveness probe
//   GET  /sub/{token}       → subscription (base64 VLESS configs)
//   WS   /{uuid}            → direct VLESS tunnel (per-user)
//   WS   /route/{code}      → country-routed tunnel (fastest-proxy race)
//   ALL  /spider            → admin panel (first login claims the admin token)
//   ALL  /spider/*          → admin JSON API (session cookie or Bearer token)
//
// KV layout (SPIDER_KV): spider:setup, user:{uuid}, ips:{uuid}, proxies,
// sub:{token}, sess:{sid}
// ══════════════════════════════════════════════════════════════════════════════

import { UUID_RE, getUser, handleVlessWs } from "./tunnel.js";
import { PANEL_PATH, handlePanel, handleSubscription } from "./panel.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const seg = path.split("/").filter(Boolean);
    const first = (seg[0] || "").toLowerCase();

    // ── Health ──
    if (path === "/health") {
      return new Response("SpiderPanel online", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // ── Root: send visitors to the panel ──
    if (path === "/") {
      return new Response(null, { status: 302, headers: { location: PANEL_PATH } });
    }

    // ── Subscription ──
    if (first === "sub" && seg[1]) {
      return handleSubscription(request, env, url, seg[1]);
    }

    // ── VLESS WS tunnels ──
    if (first === "route" && seg[1]) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response(JSON.stringify({ error: "websocket upgrade required" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return handleVlessWs(request, env, seg[1].toLowerCase(), null);
    }

    if (UUID_RE.test(first) && request.headers.get("Upgrade") === "websocket") {
      const u = await getUser(env, first);
      if (!u) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
      return handleVlessWs(request, env, "", u);
    }

    // ── Panel ──
    if (path === PANEL_PATH || path === PANEL_PATH + "/" || path.startsWith(PANEL_PATH + "/")) {
      return handlePanel(request, env, url);
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  },
};
