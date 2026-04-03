export type AiQuality = "EXEMPLARY" | "HIGH" | "MEDIUM" | "LOW";

export type SelfPromoRisk = "HIGH" | "MEDIUM" | "LOW";

export type AiCategory =
  | "TUTORIAL"
  | "TOOL"
  | "INSIGHT"
  | "SHOWCASE"
  | "DISCUSSION"
  | "META";

/** Raw post data from Reddit's .json endpoint */
export interface RedditPost {
  id: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string;
  permalink: string;
  ups: number;
  num_comments: number;
  upvote_ratio: number;
  created_utc: number;
  is_self: boolean;
  url: string;
  link_flair_text: string | null;
  removed_by_category?: string | null;
}

/** Post after pre-filtering and engagement scoring */
export interface ScoredPost {
  reddit_post_id: string;
  subreddit: string;
  title: string;
  body_snippet: string;
  author: string;
  permalink: string;
  url: string;
  upvotes: number;
  comment_count: number;
  upvote_ratio: number;
  engagement_score: number;
  posted_at: string;
}

/** Post after AI classification */
export interface ClassifiedPost extends ScoredPost {
  ai_quality: AiQuality;
  ai_category: AiCategory;
  ai_summary: string;
  ai_reasoning: string;
  self_promo_risk: SelfPromoRisk;
  display_score: number;
  scored_at: string;
}

/** Row from the signal_posts table */
export interface SignalPost {
  id: string;
  reddit_post_id: string;
  subreddit: string;
  title: string;
  body_snippet: string | null;
  author: string;
  permalink: string;
  upvotes: number;
  comment_count: number;
  upvote_ratio: number;
  engagement_score: number;
  ai_quality: AiQuality;
  ai_category: AiCategory | null;
  ai_summary: string | null;
  ai_reasoning: string | null;
  self_promo_risk: SelfPromoRisk;
  boost_count: number;
  display_score: number;
  posted_at: string;
  fetched_at: string;
  scored_at: string | null;
  is_available: boolean;
  availability_checked_at: string | null;
  unavailable_reason: string | null;
}

/** Subreddit config for monitoring */
export interface SubredditConfig {
  name: string;
  minScore: number;
  communitySize: number;
}

export type SignalSourceKind = "subreddit" | "keyword";

export interface SignalSourceDefinition {
  key: string;
  kind: SignalSourceKind;
  value: string;
  label: string;
}

export interface SignalSourceStateRow {
  source_key: string;
  kind: SignalSourceKind;
  source_value: string;
  last_success_payload: RedditPost[] | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  consecutive_failures: number;
  cooldown_until: string | null;
}

export interface SignalCurrentSnapshotRow {
  snapshot_key: string;
  posts: SignalPost[];
  post_count: number;
  source_last_refresh: string | null;
  published_at: string;
  window_hours: number;
  build_meta: Record<string, unknown> | null;
}
