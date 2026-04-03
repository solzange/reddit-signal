import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiCategory } from "@/lib/signal/types";
import { FEED_SIZE, WINDOW_HOURS } from "@/lib/signal/config";
import { selectFeedPosts } from "@/lib/signal/diversity";
import { getCurrentSignalSnapshot } from "@/lib/signal";

const PAGE_SIZE = FEED_SIZE;
const VALID_CATEGORIES: AiCategory[] = [
  "TUTORIAL", "TOOL", "INSIGHT", "SHOWCASE", "DISCUSSION", "META",
];
const DIVERSITY_FETCH_MULTIPLIER = 3;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const category = searchParams.get("category")?.toUpperCase();
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const dateParam = searchParams.get("date");

  const supabase = createAdminClient();
  const isFirstPage = page === 1;
  const hasCategory = category && VALID_CATEGORIES.includes(category as AiCategory);
  const liveCutoff = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  if (isFirstPage && !hasCategory && !dateParam) {
    const snapshot = await getCurrentSignalSnapshot(supabase);
    if (snapshot) {
      return NextResponse.json(
        { posts: snapshot.posts, nextPage: null, lastRefresh: snapshot.sourceLastRefresh },
        { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } }
      );
    }
  }

  const fetchLimit = isFirstPage && !hasCategory
    ? PAGE_SIZE * DIVERSITY_FETCH_MULTIPLIER
    : PAGE_SIZE + 1;

  const offset = isFirstPage ? 0 : (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("signal_posts")
    .select(
      "id, reddit_post_id, subreddit, title, body_snippet, author, permalink, upvotes, comment_count, ai_quality, ai_category, ai_summary, ai_reasoning, boost_count, display_score, engagement_score, posted_at, fetched_at"
    )
    .eq("is_available", true)
    .order("display_score", { ascending: false })
    .order("engagement_score", { ascending: false })
    .range(offset, offset + fetchLimit - 1);

  if (hasCategory) {
    query = query.eq("ai_category", category);
  }

  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const start = new Date(`${dateParam}T00:00:00Z`);
    const end = new Date(start.getTime() + 86_400_000);
    query = query
      .gte("posted_at", start.toISOString())
      .lt("posted_at", end.toISOString());
  } else {
    query = query.gte("posted_at", liveCutoff);
  }

  const [{ data, error }, { data: latestRefreshRow }] = await Promise.all([
    query,
    supabase
      .from("signal_posts")
      .select("fetched_at")
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) {
    console.error("signal: API query failed:", error);
    return NextResponse.json({ error: "Failed to fetch posts" }, { status: 500 });
  }

  let posts = data ?? [];

  if (isFirstPage && !hasCategory && posts.length > PAGE_SIZE) {
    posts = selectFeedPosts(posts, PAGE_SIZE);
  }

  const hasMore = posts.length > PAGE_SIZE && !(isFirstPage && !hasCategory);
  const items = posts.slice(0, PAGE_SIZE);
  const lastRefresh = latestRefreshRow?.fetched_at ?? null;

  return NextResponse.json(
    { posts: items, nextPage: hasMore ? page + 1 : null, lastRefresh },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } }
  );
}
