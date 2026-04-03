import { MAX_PER_SUBREDDIT, MAX_PER_CATEGORY } from "./config";

/**
 * Diversity reranking: cap posts per subreddit and per category.
 * Posts must be pre-sorted by display_score descending.
 */
export function applyDiversityFilter<
  T extends { subreddit: string; ai_category: string | null }
>(posts: T[], limit: number): T[] {
  const subCounts = new Map<string, number>();
  const catCounts = new Map<string, number>();
  const result: T[] = [];

  for (const post of posts) {
    if (result.length >= limit + 1) break;

    const subKey = post.subreddit.toLowerCase();
    const subCount = subCounts.get(subKey) ?? 0;
    if (subCount >= MAX_PER_SUBREDDIT) continue;

    const cat = post.ai_category ?? "DISCUSSION";
    const catCount = catCounts.get(cat) ?? 0;
    if (catCount >= MAX_PER_CATEGORY) continue;

    result.push(post);
    subCounts.set(subKey, subCount + 1);
    catCounts.set(cat, catCount + 1);
  }

  return result;
}

export function selectFeedPosts<
  T extends {
    id: string;
    subreddit: string;
    ai_category: string | null;
    ai_quality: string;
  }
>(posts: T[], limit: number): T[] {
  const primary = applyDiversityFilter(
    posts.filter((post) => post.ai_quality !== "LOW"),
    limit
  ).slice(0, limit);

  if (primary.length >= limit) {
    return primary;
  }

  const selectedIds = new Set(primary.map((post) => post.id));
  const fallback = posts.filter((post) => !selectedIds.has(post.id));

  for (const post of fallback) {
    if (primary.length >= limit) break;
    primary.push(post);
  }

  return primary;
}

export function selectWeeklyPosts<
  T extends { subreddit: string; ai_category: string | null; ai_quality: string }
>(posts: T[], limit: number): T[] {
  return applyDiversityFilter(
    posts.filter((post) => post.ai_quality !== "LOW"),
    limit
  ).slice(0, limit);
}
