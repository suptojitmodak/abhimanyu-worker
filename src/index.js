import { DurableObject } from "cloudflare:workers";

// ---- সেটিংস ----
const APK_PATH = "/files/abhimanyu.apk"; // public/files/ ফোল্ডারে APK রাখুন
const APK_NAME = "Abhimanyu.apk";
const MAX_NEW_PER_IP_PER_DAY = 10; // একই আইপি থেকে দিনে সর্বোচ্চ কত নতুন ডাউনলোড গোনা হবে
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|httpclient/i;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

function secure(res) {
  const out = new Response(res.body, res);
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

async function handleCount(env, ctx, url) {
  const cache = caches.default;
  const key = new Request(url.origin + "/count");
  let res = await cache.match(key);
  if (!res) {
    let n;
    try {
      n = await counter(env).total();
    } catch {
      return new Response('{"error":true}', { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    res = new Response(JSON.stringify({ count: n }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
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
    return secure(await env.ASSETS.fetch(req));
  },
};
