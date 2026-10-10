import { DurableObject } from "cloudflare:workers";

// ---- সেটিংস ----
const APK_PATH = "/files/abhimanyu.apk"; // public/files/ ফোল্ডারে APK রাখুন
const APK_NAME = "Abhimanyu.apk";
const MAX_NEW_PER_IP_PER_DAY = 10; // একই আইপি থেকে দিনে সর্বোচ্চ কত নতুন ডাউনলোড গোনা হবে
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|httpclient/i;

const BASE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

// ---- Durable Object: নিখুঁত কাউন্ট (SQLite) ----
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS visitors (vid TEXT PRIMARY KEY, ip TEXT NOT NULL, ts INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_ip_ts ON visitors (ip, ts)");
  }
  claim(vid, ip) {
    if (this.sql.exec("SELECT 1 FROM visitors WHERE vid = ?", vid).toArray().length) return false;
    const since = Date.now() - 86400000;
    const recent = this.sql.exec("SELECT COUNT(*) AS c FROM visitors WHERE ip = ? AND ts > ?", ip, since).one().c;
    if (recent >= MAX_NEW_PER_IP_PER_DAY) return false;
    this.sql.exec("INSERT INTO visitors (vid, ip, ts) VALUES (?, ?, ?)", vid, ip, Date.now());
    return true;
  }
  total() {
    return this.sql.exec("SELECT COUNT(*) AS c FROM visitors").one().c;
  }
}

const counter = (env) => env.COUNTER.get(env.COUNTER.idFromName("main"));

async function ipHash(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const net = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip; // IPv6 হলে /64
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.IP_SALT || "abhimanyu") + "|" + net));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secure(res, csp = BASE_CSP) {
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function handleDownload(req, env, ctx, url) {
  // অন্য সাইট থেকে লুকিয়ে /download ট্রিগার (ছবি/ফ্রেম দিয়ে) বন্ধ
  const site = req.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return new Response("Forbidden", { status: 403 });

  const fwd = new Headers();
  for (const h of ["range", "if-range"]) if (req.headers.get(h)) fwd.set(h, req.headers.get(h));
  const asset = await env.ASSETS.fetch(new Request(new URL(APK_PATH, url.origin), { method: "GET", headers: fwd }));
  if (asset.status !== 200 && asset.status !== 206) return new Response("ফাইল পাওয়া যায়নি", { status: 404 });

  const headers = new Headers();
  for (const h of ["content-length", "content-range", "accept-ranges", "etag"]) if (asset.headers.get(h)) headers.set(h, asset.headers.get(h));
  headers.set("Content-Type", "application/vnd.android.package-archive");
  headers.set("Content-Disposition", `attachment; filename="${APK_NAME}"`);
  headers.set("Cache-Control", "private, max-age=0");
  headers.set("X-Robots-Tag", "noindex");

  // কাউন্ট: শুধু GET, বট নয়, ফাইল সত্যিই আছে
  const cookie = /(?:^|;\s*)vid=([0-9a-f-]{36})(?:;|$)/.exec(req.headers.get("Cookie") || "");
  const vid = cookie ? cookie[1] : crypto.randomUUID();
  if (!cookie) headers.append("Set-Cookie", `vid=${vid}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`);
  if (req.method === "GET" && !BOT_RE.test(req.headers.get("User-Agent") || "")) {
    ctx.waitUntil(
      ipHash(req, env).then((ip) => counter(env).claim(vid, ip)).catch(() => {}) // কাউন্টে সমস্যা হলেও ডাউনলোড আটকাবে না
    );
  }
  return new Response(req.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
}

async function apkSize(env, url) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(APK_PATH, url.origin), { method: "GET" }));
    if (!r.ok) return null;
    let len = Number(r.headers.get("content-length"));
    if (len > 0) {
      r.body && r.body.cancel().catch(() => {});
      return len;
    }
    len = 0; // content-length না থাকলে বাইট গুনে নিই
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      len += value.length;
    }
    return len > 0 ? len : null;
  } catch {
    return null;
  }
}

async function getStats(env, ctx, url) {
  const cache = caches.default;
  const key = new Request(url.origin + "/count");
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const [count, size] = await Promise.all([counter(env).total(), apkSize(env, url)]);
  const stats = { count, size };
  ctx.waitUntil(
    cache.put(key, new Response(JSON.stringify(stats), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } }))
  );
  return stats;
}

async function handleCount(env, ctx, url) {
  let stats;
  try {
    stats = await getStats(env, ctx, url);
  } catch {
    return new Response('{"error":true}', { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  return new Response(JSON.stringify(stats), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
}

const bnInt = new Intl.NumberFormat("bn-BD");
const bnMb = new Intl.NumberFormat("bn-BD", { maximumFractionDigits: 1 });

async function sriHash(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return "'sha256-" + btoa(String.fromCharCode(...d)) + "'";
}

// হোম পেজ: সংখ্যা সার্ভারেই বসিয়ে দেই (প্রথম পেইন্টেই আসল ডাটা), CSS/JS ইনলাইন + হ্যাশ-লক করা CSP
async function handleHome(req, env, ctx, url) {
  const asset = await env.ASSETS.fetch(new Request(url.origin + "/", { method: "GET" }));
  if (!asset.ok) return secure(asset);
  let html = await asset.text();
  let stats = null;
  try {
    stats = await getStats(env, ctx, url);
  } catch {}
  const count = stats ? bnInt.format(stats.count) : "—";
  const size = stats && stats.size ? bnMb.format(stats.size / 1048576) + " MB" : "—";
  html = html.replace("__COUNT__", () => count).replace("__SIZE__", () => size);

  const style = (/<style>([\s\S]*?)<\/style>/.exec(html) || [])[1] || "";
  const script = (/<script>([\s\S]*?)<\/script>/.exec(html) || [])[1] || "";
  const csp =
    `default-src 'none'; script-src ${await sriHash(script)}; style-src ${await sriHash(style)}; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const res = new Response(req.method === "HEAD" ? null : html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
  return secure(res, csp);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "GET" && req.method !== "HEAD") return secure(new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } }));
    const url = new URL(req.url);
    let path;
    try {
      path = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      return secure(new Response("Bad Request", { status: 400 }));
    }
    if (path.includes("..") || path.includes("\\")) return secure(new Response("Bad Request", { status: 400 }));

    if (path === "/download") return secure(await handleDownload(req, env, ctx, url));
    if (path === "/count") return secure(await handleCount(env, ctx, url));
    if (path.startsWith("/files")) return secure(new Response("Not Found", { status: 404 })); // সরাসরি APK লিংক বন্ধ
    if (path === "/" || path === "/index.html") return handleHome(req, env, ctx, url);
    const r = await env.ASSETS.fetch(req);
    if (r.ok && /\.(woff2|webp|png)$/.test(path)) {
      const out = new Response(r.body, r);
      out.headers.set("Cache-Control", "public, max-age=2592000");
      return secure(out);
    }
    return secure(r);
  },
};
