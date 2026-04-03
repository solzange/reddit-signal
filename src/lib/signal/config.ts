import { getSignalConfig } from "@/signal.config";
import type { SubredditConfig } from "./types";

const c = getSignalConfig();

const DEFAULT_COMMUNITY_SIZE_VALUE = 10_000;
const DEFAULT_MIN_SCORE = 8;

// --- Build subreddit list from user config ---
function buildSubreddits(): SubredditConfig[] {
  const all = [
    ...(c.subreddits.core ?? []),
    ...(c.subreddits.rotating ?? []),
  ];
  return all.map((sub) => ({
    name: sub.name,
    minScore: sub.minScore ?? DEFAULT_MIN_SCORE,
    communitySize: sub.communitySize ?? DEFAULT_COMMUNITY_SIZE_VALUE,
  }));
}

export const SUBREDDITS: SubredditConfig[] = buildSubreddits();

export const SEARCH_KEYWORDS: string[] = c.keywords ?? [];

export const CORE_SUBREDDITS: string[] = c.subreddits.core.map((s) => s.name);
export const ROTATING_SUBREDDITS_PER_RUN = 2;
export const ROTATING_KEYWORDS_PER_RUN = 3;

// --- Algorithm parameters ---
export const COMMENT_BOOST_CAP = 1.5;

export const QUALITY_MULTIPLIER: Record<string, number> = {
  EXEMPLARY: 3.0,
  HIGH: 2.0,
  MEDIUM: 1.0,
  LOW: 0,
};

export const SELF_PROMO_MULTIPLIER: Record<string, number> = {
  HIGH: 0.3,
  MEDIUM: 0.8,
  LOW: 1.0,
};

// --- Pre-filter thresholds ---
export const MIN_UPVOTE_RATIO = 0.70;
export const MIN_COMMENTS = 1;

// --- Diversity constraints ---
export const MAX_PER_SUBREDDIT = c.maxPerSubreddit ?? 3;
export const MAX_PER_CATEGORY = c.maxPerCategory ?? 4;
export const FEED_SIZE = c.feedSize ?? 9;

// --- Time window ---
export const WINDOW_HOURS = c.windowHours ?? 24;
export const SOURCE_CACHE_TTL_HOURS = 72;
export const SOURCE_COOLDOWN_HOURS = 12;
export const SOURCE_FAILURE_COOLDOWN_THRESHOLD = 2;
export const AVAILABILITY_RECHECK_HOURS = 168;

// --- Rate limiting for Reddit requests ---
export const REDDIT_REQUEST_DELAY_MS = 2000;
export const MAX_POSTS_FOR_AI_SCORING = 12;
export const REDDIT_USER_AGENT = "reddit-signal/1.0 (github.com/solzange/reddit-signal)";

// --- Community size estimates ---
export const COMMUNITY_SIZES: Record<string, number> = Object.fromEntries(
  SUBREDDITS.map((s) => [s.name, s.communitySize])
);
export const DEFAULT_COMMUNITY_SIZE = DEFAULT_COMMUNITY_SIZE_VALUE;

// --- Domain penalties ---
export const PROMO_DOMAINS = [
  "producthunt.com",
  "apps.apple.com",
  "play.google.com",
  "gumroad.com",
  "lemonsqueezy.com",
];
export const DOMAIN_PENALTY = 0.5;
