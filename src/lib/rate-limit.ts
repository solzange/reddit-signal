import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
let hasWarnedAboutInMemoryFallback = false;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 60_000);

interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  identifier?: string;
}

export function buildRateLimitIdentifier(
  scope: string,
  rawValue: string | null | undefined
): string | null {
  const value = rawValue?.trim();
  if (!value) return null;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${scope}:${digest}`;
}

export async function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): Promise<Response | null> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const identifier = options.identifier?.trim() || ip;
  const key = `${identifier}:${request.nextUrl.pathname}`;

  if (upstashUrl && upstashToken) {
    const blocked = await rateLimitWithUpstash(key, options);
    if (blocked !== "fallback") return blocked;
  }

  if (process.env.NODE_ENV === "production" && !hasWarnedAboutInMemoryFallback) {
    hasWarnedAboutInMemoryFallback = true;
    console.warn(
      "Using in-memory rate limiter in production. Configure Upstash Redis for reliable multi-instance rate limiting."
    );
  }

  return rateLimitInMemory(key, options);
}

function rateLimitInMemory(
  key: string,
  options: RateLimitOptions
): NextResponse | null {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + options.windowSeconds * 1000 });
    return null;
  }

  entry.count++;

  if (entry.count > options.limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": retryAfter.toString() } }
    );
  }

  return null;
}

async function rateLimitWithUpstash(
  key: string,
  options: RateLimitOptions
): Promise<NextResponse | null | "fallback"> {
  try {
    const pipeline = await upstashPipeline([
      ["INCR", key],
      ["TTL", key],
    ]);

    const count = Number(pipeline[0]?.result ?? 0);
    let ttl = Number(pipeline[1]?.result ?? -1);

    if (count <= 0) return "fallback";

    if (ttl < 0) {
      await upstashPipeline([["EXPIRE", key, options.windowSeconds]]);
      ttl = options.windowSeconds;
    }

    if (count > options.limit) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": Math.max(ttl, 1).toString() } }
      );
    }

    return null;
  } catch (error) {
    console.error("Upstash rate limit failed, falling back to in-memory limiter", error);
    return "fallback";
  }
}

async function upstashPipeline(commands: Array<Array<string | number>>) {
  const response = await fetch(`${upstashUrl}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${upstashToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Upstash pipeline failed with ${response.status}`);
  }

  return (await response.json()) as Array<{ result?: unknown; error?: string }>;
}
