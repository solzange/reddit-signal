/**
 * Cloudflare Worker: Reddit proxy for reddit-signal.
 * Forwards requests to Reddit's JSON API through Cloudflare's edge network,
 * bypassing Reddit's cloud-IP blocking. Secured with a shared secret.
 */

interface Env {
  CRON_SECRET: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const SUCCESS_TTL_SECONDS = 300;
const FAILURE_TTL_SECONDS = 120;

function buildCacheKey(requestUrl: URL, targetUrl: string): Request {
  const cacheUrl = new URL(requestUrl.toString());
  cacheUrl.search = "";
  cacheUrl.searchParams.set("target", targetUrl);
  return new Request(cacheUrl.toString(), { method: "GET" });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    const auth = request.headers.get("authorization");
    const secret = url.searchParams.get("secret");

    if (!env.CRON_SECRET || (auth !== `Bearer ${env.CRON_SECRET}` && secret !== env.CRON_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl || !targetUrl.startsWith("https://www.reddit.com/")) {
      return new Response("Missing or invalid ?url= parameter", { status: 400 });
    }

    const cache = (caches as CacheStorage & { default: Cache }).default;
    const cacheKey = buildCacheKey(url, targetUrl);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("x-proxy", "cloudflare-worker");
      headers.set("x-proxy-cache", "HIT");
      return new Response(cached.body, { status: cached.status, headers });
    }

    try {
      const res = await fetch(targetUrl, {
        headers: {
          "User-Agent": "reddit-signal/1.0 (github.com/solzange/reddit-signal)",
        },
      });

      const headers = new Headers();
      headers.set("content-type", res.headers.get("content-type") || "application/json");
      headers.set("x-proxy", "cloudflare-worker");
      headers.set("x-proxy-cache", "MISS");
      headers.set(
        "Cache-Control",
        `public, max-age=0, s-maxage=${res.ok ? SUCCESS_TTL_SECONDS : FAILURE_TTL_SECONDS}`
      );

      const response = new Response(res.body, { status: res.status, headers });

      if (request.method === "GET" && (res.ok || res.status === 403 || res.status === 429)) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    } catch (err) {
      return new Response(`Proxy error: ${err}`, { status: 502 });
    }
  },
};
