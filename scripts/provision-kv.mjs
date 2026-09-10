// Auto-provision the SPIDER_KV namespace for Cloudflare Workers Builds.
//
// Cloudflare's CI (Workers Builds) runs `bun run build` with
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID already in the environment.
// This script finds or creates the KV namespace and writes its real id into
// wrangler.jsonc, replacing SPIDER_KV_PLACEHOLDER, so the subsequent
// `wrangler deploy` succeeds on a fresh clone every time.
//
// Locally (no credentials in env) it exits 0 and leaves the placeholder —
// `wrangler dev` runs in local mode and never validates the id.
import { readFileSync, writeFileSync } from "node:fs";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!account || !token) {
  console.log("[provision-kv] No Cloudflare credentials in env — skipping (local dev).");
  process.exit(0);
}

const NS_TITLE = "metsim-SPIDER_KV";
const PLACEHOLDER = "SPIDER_KV_PLACEHOLDER";
const api = "https://api.cloudflare.com/client/v4";
const headers = { Authorization: "Bearer " + token, "content-type": "application/json" };

async function findNamespace() {
  try {
    const res = await fetch(`${api}/accounts/${account}/storage/kv/namespaces?per_page=100`, { headers });
    const data = await res.json();
    if (data.success) {
      const found = (data.result || []).find((n) => n.title === NS_TITLE);
      if (found) return found.id;
      return null;
    }
    console.log("[provision-kv] list namespaces failed:", JSON.stringify(data.errors || data));
  } catch (e) {
    console.log("[provision-kv] list namespaces error:", e.message);
  }
  return null;
}

async function createNamespace() {
  try {
    const res = await fetch(`${api}/accounts/${account}/storage/kv/namespaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: NS_TITLE }),
    });
    const data = await res.json();
    if (data.success && data.result && data.result.id) return data.result.id;
    console.log("[provision-kv] create namespace failed:", JSON.stringify(data.errors || data));
  } catch (e) {
    console.log("[provision-kv] create namespace error:", e.message);
  }
  return null;
}

let id = await findNamespace();
if (!id) id = await createNamespace();
if (!id) {
  console.error(
    "[provision-kv] Could not provision the KV namespace. The Workers Builds token may lack " +
      "Workers KV Storage edit permission. Fix: create a KV namespace named '" + NS_TITLE +
      "' in the Cloudflare dashboard and put its id in wrangler.jsonc (kv_namespaces[0].id)."
  );
  process.exit(1);
}

const cfgPath = new URL("../wrangler.jsonc", import.meta.url);
const cfg = readFileSync(cfgPath, "utf8");
if (cfg.includes(PLACEHOLDER)) {
  writeFileSync(cfgPath, cfg.replace(PLACEHOLDER, id));
  console.log("[provision-kv] wrangler.jsonc updated with KV namespace id:", id);
} else if (cfg.includes(id)) {
  console.log("[provision-kv] wrangler.jsonc already bound to KV namespace", id);
} else {
  console.log("[provision-kv] wrangler.jsonc has a non-placeholder KV id — leaving it untouched.");
}
