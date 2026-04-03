import type {
  RedditPost,
  SignalSourceDefinition,
  SignalSourceStateRow,
} from "./types";
import {
  SUBREDDITS,
  SEARCH_KEYWORDS,
  REDDIT_REQUEST_DELAY_MS,
  REDDIT_USER_AGENT,
  WINDOW_HOURS,
  CORE_SUBREDDITS,
  ROTATING_KEYWORDS_PER_RUN,
  ROTATING_SUBREDDITS_PER_RUN,
  SOURCE_CACHE_TTL_HOURS,
  SOURCE_COOLDOWN_HOURS,
  SOURCE_FAILURE_COOLDOWN_THRESHOLD,
} from "./config";
import { isUnavailableRedditPost } from "./scoring";

const REDDIT_BASE = "https://www.reddit.com";
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 5_000;
const CONSECUTIVE_SOURCE_FAILURE_THRESHOLD = 5;
const REDDIT_INFO_BATCH_SIZE = 50;

export type FetchStatus =
  | "success"
  | "blocked"
  | "rate_limited"
  | "error"
  | "cooldown"
  | "fallback";

interface FetchResult {
  posts: RedditPost[];
  status: FetchStatus;
}

export interface SignalSourceResult {
  source: SignalSourceDefinition;
  status: FetchStatus;
  liveStatus: FetchStatus | null;
  posts: RedditPost[];
  usedFallback: boolean;
}

export interface FetchAllRedditPostsResult {
  posts: RedditPost[];
  sourceResults: SignalSourceResult[];
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesBlocked: number;
  sourcesRateLimited: number;
  sourcesErrored: number;
  sourcesFromFallback: number;
}

function buildFetchTarget(url: string): {
  url: string;
  headers: Record<string, string>;
} {
  const proxy = process.env.REDDIT_PROXY_URL;
  const headers: Record<string, string> = {
    "User-Agent": REDDIT_USER_AGENT,
  };

  if (!proxy) {
    return { url, headers };
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }

  return {
    url: `${proxy}?url=${encodeURIComponent(url)}`,
    headers,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 750);
}

function buildSourceKey(kind: SignalSourceDefinition["kind"], value: string): string {
  return `${kind}:${value.toLowerCase()}`;
}

function createSource(kind: SignalSourceDefinition["kind"], value: string): SignalSourceDefinition {
  return {
    key: buildSourceKey(kind, value),
    kind,
    value,
    label: kind === "subreddit" ? `r/${value}` : `search:${value}`,
  };
}

function pickRotating<T>(items: T[], count: number, seed: number): T[] {
  if (items.length <= count) return items;
  const start = ((seed % items.length) + items.length) % items.length;
  const rotated = items.slice(start).concat(items.slice(0, start));
  return rotated.slice(0, count);
}

export function getSignalSources(now = new Date()): SignalSourceDefinition[] {
  const utcDaySeed = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000
  );

  const coreSubreddits = SUBREDDITS
    .filter((sub) => CORE_SUBREDDITS.includes(sub.name))
    .map((sub) => createSource("subreddit", sub.name));

  const rotatingSubreddits = pickRotating(
    SUBREDDITS
      .filter((sub) => !CORE_SUBREDDITS.includes(sub.name))
      .map((sub) => createSource("subreddit", sub.name)),
    ROTATING_SUBREDDITS_PER_RUN,
    utcDaySeed
  );

  const rotatingKeywords = pickRotating(
    SEARCH_KEYWORDS.map((keyword) => createSource("keyword", keyword)),
    ROTATING_KEYWORDS_PER_RUN,
    utcDaySeed * 3
  );

  return [...coreSubreddits, ...rotatingSubreddits, ...rotatingKeywords];
}

function isCacheFresh(state: SignalSourceStateRow | undefined, now: Date): boolean {
  if (!state?.last_success_at) return false;
  const ageMs = now.getTime() - new Date(state.last_success_at).getTime();
  return ageMs <= SOURCE_CACHE_TTL_HOURS * 3_600_000;
}

function getCachedPosts(state: SignalSourceStateRow | undefined, now: Date): RedditPost[] {
  if (!state || !isCacheFresh(state, now)) return [];
  const payload = Array.isArray(state.last_success_payload) ? state.last_success_payload : [];
  return payload
    .filter((post): post is RedditPost => Boolean(post && typeof post === "object"))
    .filter((post) => !isUnavailableRedditPost(post));
}

function isSourceCoolingDown(state: SignalSourceStateRow | undefined, now: Date): boolean {
  if (!state?.cooldown_until) return false;
  return new Date(state.cooldown_until).getTime() > now.getTime();
}

function parseRedditPost(d: Record<string, unknown>): RedditPost | null {
  const id = d.id;
  const ups = Number(d.ups);
  const num_comments = Number(d.num_comments);
  const upvote_ratio = Number(d.upvote_ratio);
  const created_utc = Number(d.created_utc);

  if (
    typeof id !== "string" ||
    !id ||
    isNaN(ups) ||
    isNaN(num_comments) ||
    isNaN(upvote_ratio) ||
    isNaN(created_utc)
  ) {
    return null;
  }

  return {
    id,
    subreddit: String(d.subreddit ?? ""),
    title: String(d.title ?? ""),
    selftext: String(d.selftext ?? ""),
    author: String(d.author ?? "[unknown]"),
    permalink: String(d.permalink ?? ""),
    ups,
    num_comments,
    upvote_ratio,
    created_utc,
    is_self: Boolean(d.is_self),
    url: String(d.url ?? ""),
    link_flair_text: d.link_flair_text ? String(d.link_flair_text) : null,
    removed_by_category: d.removed_by_category
      ? String(d.removed_by_category)
      : null,
  };
}

async function fetchListing(url: string, label: string): Promise<FetchResult> {
  let sawRateLimit = false;
  const target = buildFetchTarget(url);

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const res = await fetch(target.url, {
        headers: target.headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 429) {
        sawRateLimit = true;
        console.warn(`signal: ${label} returned 429`);
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(jitter(RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt)));
          continue;
        }
        return { posts: [], status: "rate_limited" };
      }

      if (res.status === 403) {
        console.warn(`signal: ${label} returned 403`);
        return { posts: [], status: "blocked" };
      }

      if (!res.ok) {
        console.warn(`signal: ${label} returned ${res.status}`);
        return { posts: [], status: "error" };
      }

      const json = await res.json();
      const children = json?.data?.children ?? [];
      const posts: RedditPost[] = [];

      for (const child of children) {
        if (child.kind !== "t3") continue;
        const post = parseRedditPost(child.data);
        if (post && !isUnavailableRedditPost(post)) posts.push(post);
      }

      return { posts, status: "success" };
    } catch (err) {
      console.error(`signal: Failed to fetch ${label}:`, err);
      if (sawRateLimit) {
        return { posts: [], status: "rate_limited" };
      }
      return { posts: [], status: "error" };
    } finally {
      await sleep(REDDIT_REQUEST_DELAY_MS);
    }
  }

  return { posts: [], status: sawRateLimit ? "rate_limited" : "error" };
}

async function fetchSubreddit(subreddit: string): Promise<FetchResult> {
  const posts: RedditPost[] = [];
  let status: FetchStatus = "error";

  for (const sort of ["hot", "new"] as const) {
    const url = `${REDDIT_BASE}/r/${subreddit}/${sort}.json?limit=50&raw_json=1`;
    const result = await fetchListing(url, `Reddit ${sort} r/${subreddit}`);
    if (result.status === "success") status = "success";
    else if (status !== "success") status = result.status;
    posts.push(...result.posts);
  }

  return { posts, status };
}

async function searchReddit(keyword: string): Promise<FetchResult> {
  const q = encodeURIComponent(keyword);
  const url = `${REDDIT_BASE}/search.json?q=${q}&sort=new&t=week&limit=50&raw_json=1`;
  return fetchListing(url, `Reddit search "${keyword}"`);
}

async function fetchSource(source: SignalSourceDefinition): Promise<FetchResult> {
  return source.kind === "subreddit"
    ? fetchSubreddit(source.value)
    : searchReddit(source.value);
}

function dedupeRecentPosts(posts: RedditPost[]): RedditPost[] {
  const seen = new Set<string>();
  const cutoff = Date.now() / 1000 - WINDOW_HOURS * 3600;
  const deduped: RedditPost[] = [];

  for (const post of posts) {
    if (seen.has(post.id)) continue;
    if (post.created_utc < cutoff) continue;
    seen.add(post.id);
    deduped.push(post);
  }

  return deduped;
}

export async function fetchAllRedditPosts(
  sourceStateMap: Map<string, SignalSourceStateRow> = new Map(),
  now = new Date(),
  selectedSources: SignalSourceDefinition[] = getSignalSources(now)
): Promise<FetchAllRedditPostsResult> {
  const sourceResults: SignalSourceResult[] = [];
  let sourcesAttempted = 0;
  let sourcesSucceeded = 0;
  let sourcesBlocked = 0;
  let sourcesRateLimited = 0;
  let sourcesErrored = 0;
  let sourcesFromFallback = 0;
  let consecutiveSourceFailures = 0;

  for (const source of selectedSources) {
    const state = sourceStateMap.get(source.key);
    const cachedPosts = getCachedPosts(state, now);

    if (isSourceCoolingDown(state, now)) {
      if (cachedPosts.length > 0) {
        sourcesFromFallback++;
        sourceResults.push({
          source,
          status: "cooldown",
          liveStatus: null,
          posts: cachedPosts,
          usedFallback: true,
        });
      } else {
        sourcesErrored++;
        sourceResults.push({
          source,
          status: "cooldown",
          liveStatus: null,
          posts: [],
          usedFallback: false,
        });
      }
      continue;
    }

    sourcesAttempted++;
    const result = await fetchSource(source);

    if (result.status === "success") {
      sourcesSucceeded++;
      consecutiveSourceFailures = 0;
      sourceResults.push({
        source,
        status: "success",
        liveStatus: "success",
        posts: result.posts,
        usedFallback: false,
      });
      continue;
    }

    consecutiveSourceFailures++;
    if (result.status === "blocked") sourcesBlocked++;
    else if (result.status === "rate_limited") sourcesRateLimited++;
    else sourcesErrored++;

    if (cachedPosts.length > 0) {
      sourcesFromFallback++;
      sourceResults.push({
        source,
        status: "fallback",
        liveStatus: result.status,
        posts: cachedPosts,
        usedFallback: true,
      });
    } else {
      sourceResults.push({
        source,
        status: result.status,
        liveStatus: result.status,
        posts: [],
        usedFallback: false,
      });
    }

    if (consecutiveSourceFailures >= CONSECUTIVE_SOURCE_FAILURE_THRESHOLD) {
      console.warn(
        `signal: Aborting Reddit fetch after ${consecutiveSourceFailures} consecutive source failures`
      );
      break;
    }
  }

  const allPosts = dedupeRecentPosts(sourceResults.flatMap((result) => result.posts));

  console.info(
    `signal: Fetched ${allPosts.length} unique posts from Reddit (${sourcesSucceeded}/${sourcesAttempted} live sources succeeded, ${sourcesFromFallback} fallback, ${sourcesBlocked} blocked, ${sourcesRateLimited} rate-limited, ${sourcesErrored} errored)`
  );

  return {
    posts: allPosts,
    sourceResults,
    sourcesAttempted,
    sourcesSucceeded,
    sourcesBlocked,
    sourcesRateLimited,
    sourcesErrored,
    sourcesFromFallback,
  };
}

export function buildSourceStateUpsert(
  result: SignalSourceResult,
  previous: SignalSourceStateRow | undefined,
  now = new Date()
): SignalSourceStateRow {
  const liveFailure =
    result.liveStatus === "blocked" ||
    result.liveStatus === "rate_limited" ||
    result.liveStatus === "error";
  const consecutiveFailures = liveFailure
    ? (previous?.consecutive_failures ?? 0) + 1
    : 0;
  const shouldCoolDown =
    liveFailure && consecutiveFailures >= SOURCE_FAILURE_COOLDOWN_THRESHOLD;

  return {
    source_key: result.source.key,
    kind: result.source.kind,
    source_value: result.source.value,
    last_success_payload:
      result.status === "success"
        ? result.posts
        : previous?.last_success_payload ?? null,
    last_success_at:
      result.status === "success"
        ? now.toISOString()
        : previous?.last_success_at ?? null,
    last_attempt_at: now.toISOString(),
    last_status: result.status,
    consecutive_failures: consecutiveFailures,
    cooldown_until: shouldCoolDown
      ? new Date(now.getTime() + SOURCE_COOLDOWN_HOURS * 3_600_000).toISOString()
      : liveFailure
        ? previous?.cooldown_until ?? null
        : null,
  };
}

export interface RedditAvailability {
  isAvailable: boolean;
  reason: string | null;
}

export async function fetchAvailabilityByRedditIds(
  redditIds: string[]
): Promise<Map<string, RedditAvailability>> {
  const availability = new Map<string, RedditAvailability>();
  if (redditIds.length === 0) return availability;

  for (let i = 0; i < redditIds.length; i += REDDIT_INFO_BATCH_SIZE) {
    const batch = redditIds.slice(i, i + REDDIT_INFO_BATCH_SIZE);
    const url = `${REDDIT_BASE}/by_id/t3_${batch.join(",t3_")}.json?raw_json=1`;
    const result = await fetchListing(url, `Reddit by_id batch ${i / REDDIT_INFO_BATCH_SIZE + 1}`);

    if (result.status !== "success") {
      console.warn(
        `signal: Skipping availability updates for batch ${i / REDDIT_INFO_BATCH_SIZE + 1} because Reddit by_id returned ${result.status}`
      );
      continue;
    }

    const returnedIds = new Set<string>();

    for (const post of result.posts) {
      returnedIds.add(post.id);
      const unavailable = isUnavailableRedditPost(post);
      availability.set(post.id, {
        isAvailable: !unavailable,
        reason: unavailable
          ? ((post.removed_by_category ?? post.selftext.trim()) || "removed_or_deleted")
          : null,
      });
    }

    for (const id of batch) {
      if (!returnedIds.has(id)) {
        availability.set(id, { isAvailable: false, reason: "missing_from_reddit" });
      }
    }
  }

  return availability;
}
