import type { RedditPost, ScoredPost } from "./types";
import {
  SUBREDDITS,
  COMMENT_BOOST_CAP,
  MIN_UPVOTE_RATIO,
  MIN_COMMENTS,
  QUALITY_MULTIPLIER,
  SELF_PROMO_MULTIPLIER,
  COMMUNITY_SIZES,
  DEFAULT_COMMUNITY_SIZE,
  PROMO_DOMAINS,
  DOMAIN_PENALTY,
} from "./config";

/**
 * Pre-filter: remove posts that don't meet minimum quality thresholds.
 */
export function preFilter(posts: RedditPost[]): RedditPost[] {
  const minScores = new Map(SUBREDDITS.map((s) => [s.name.toLowerCase(), s.minScore]));

  return posts.filter((post) => {
    if (post.upvote_ratio < MIN_UPVOTE_RATIO) return false;
    if (post.num_comments < MIN_COMMENTS) return false;
    if (post.author === "[deleted]") return false;
    if (post.removed_by_category) return false;
    if (isUnavailableRedditPost(post)) return false;

    const subMin = minScores.get(post.subreddit.toLowerCase()) ?? 5;
    if (post.ups < subMin) return false;

    return true;
  });
}

/**
 * HN-style engagement scoring with community-size normalization and controversy penalty.
 */
export function calculateEngagementScore(post: RedditPost): number {
  let score = Math.pow(Math.max(post.ups, 1), 0.8);

  const communitySize = COMMUNITY_SIZES[post.subreddit] ?? DEFAULT_COMMUNITY_SIZE;
  score /= Math.log10(communitySize);

  const commentRatio = post.ups > 0 ? post.num_comments / post.ups : 0;
  const commentBoost = 1 + Math.min(commentRatio, COMMENT_BOOST_CAP);
  score *= commentBoost;

  if (post.num_comments > post.ups && post.upvote_ratio < 0.80) {
    const penalty = Math.pow(post.ups / Math.max(post.num_comments, 1), 2);
    score *= penalty;
  }

  if (!isFinite(score)) return 0;
  return score;
}

/**
 * Convert raw Reddit posts to scored posts, sorted by engagement.
 */
export function scoreAndRank(posts: RedditPost[]): ScoredPost[] {
  return posts
    .map((post) => ({
      reddit_post_id: post.id,
      subreddit: post.subreddit,
      title: post.title,
      body_snippet: (post.selftext || "").slice(0, 500),
      author: post.author,
      permalink: `https://www.reddit.com${post.permalink}`,
      url: post.is_self ? `https://www.reddit.com${post.permalink}` : post.url,
      upvotes: post.ups,
      comment_count: post.num_comments,
      upvote_ratio: post.upvote_ratio,
      engagement_score: calculateEngagementScore(post),
      posted_at: new Date(post.created_utc * 1000).toISOString(),
    }))
    .sort((a, b) => b.engagement_score - a.engagement_score);
}

export function isUnavailableRedditPost(
  post: Pick<RedditPost, "author" | "selftext" | "removed_by_category" | "title">
): boolean {
  if (post.removed_by_category) return true;

  const body = post.selftext.trim().toLowerCase();
  const title = post.title.trim().toLowerCase();
  return (
    post.author === "[deleted]" ||
    body === "[removed]" ||
    body === "[deleted]" ||
    title === "[removed by reddit]"
  );
}

function hasPromoDomain(permalink: string | undefined): boolean {
  if (!permalink) return false;
  try {
    const hostname = new URL(permalink).hostname.toLowerCase();
    return PROMO_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

/**
 * Calculate display_score from engagement + AI quality + self-promo risk.
 */
export function calculateDisplayScore(
  engagementScore: number,
  aiQuality: string,
  selfPromoRisk?: string,
  url?: string
): number {
  const qualityMult = QUALITY_MULTIPLIER[aiQuality] ?? 1.0;
  const promoMult = SELF_PROMO_MULTIPLIER[selfPromoRisk ?? "LOW"] ?? 1.0;
  const domainMult = hasPromoDomain(url) ? DOMAIN_PENALTY : 1.0;
  const score = engagementScore * qualityMult * promoMult * domainMult;
  return isFinite(score) ? score : 0;
}

/**
 * Calculate display_scores for a batch using percentile-based engagement.
 */
export function calculateBatchDisplayScores(
  posts: Array<{
    engagement_score: number;
    ai_quality: string;
    self_promo_risk?: string;
    url?: string;
  }>
): number[] {
  if (posts.length === 0) return [];

  const sorted = posts
    .map((p, i) => ({ engagement: p.engagement_score, index: i }))
    .sort((a, b) => a.engagement - b.engagement);

  const percentiles = new Array<number>(posts.length);
  for (let rank = 0; rank < sorted.length; rank++) {
    percentiles[sorted[rank].index] = Math.max(
      (rank + 1) / sorted.length,
      0.05
    );
  }

  return posts.map((post, i) => {
    const qualityMult = QUALITY_MULTIPLIER[post.ai_quality] ?? 1.0;
    const promoMult = SELF_PROMO_MULTIPLIER[post.self_promo_risk ?? "LOW"] ?? 1.0;
    const domainMult = hasPromoDomain(post.url) ? DOMAIN_PENALTY : 1.0;
    const score = percentiles[i] * qualityMult * promoMult * domainMult;
    return isFinite(score) ? score : 0;
  });
}
