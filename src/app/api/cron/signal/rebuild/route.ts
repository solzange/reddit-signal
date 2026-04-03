import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAvailabilityByRedditIds } from "@/lib/signal";
import { calculateDisplayScore, calculateEngagementScore } from "@/lib/signal/scoring";

export const maxDuration = 300;

type RebuildRow = {
  reddit_post_id: string;
  subreddit: string;
  title: string;
  body_snippet: string | null;
  author: string;
  permalink: string;
  upvotes: number;
  comment_count: number;
  upvote_ratio: number;
  ai_quality: string;
  self_promo_risk: string | null;
  posted_at: string;
  fetched_at: string;
  scored_at: string | null;
  is_available: boolean;
  availability_checked_at: string | null;
  unavailable_reason: string | null;
};

const REBUILD_UPSERT_CHUNK_SIZE = 200;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const supabase = createAdminClient();
  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const dryRun = searchParams.get("dryRun") === "1";

  try {
    let query = supabase
      .from("signal_posts")
      .select(
        "reddit_post_id, subreddit, title, body_snippet, author, permalink, upvotes, comment_count, upvote_ratio, ai_quality, self_promo_risk, posted_at, fetched_at, scored_at, is_available, availability_checked_at, unavailable_reason"
      )
      .order("posted_at", { ascending: true });

    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      query = query.gte("posted_at", `${from}T00:00:00Z`);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const nextDay = new Date(`${to}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      query = query.lt("posted_at", nextDay.toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as RebuildRow[];
    const availabilityMap = await fetchAvailabilityByRedditIds(
      rows.map((row) => row.reddit_post_id)
    );

    const updates = rows.map((row) => {
      const engagement = calculateEngagementScore({
        id: row.reddit_post_id,
        subreddit: row.subreddit,
        title: row.title,
        selftext: row.body_snippet ?? "",
        author: row.author,
        permalink: row.permalink,
        ups: row.upvotes,
        num_comments: row.comment_count,
        upvote_ratio: row.upvote_ratio,
        created_utc: 0,
        is_self: true,
        url: row.permalink,
        link_flair_text: null,
        removed_by_category: null,
      });
      const availability = availabilityMap.get(row.reddit_post_id);

      return {
        reddit_post_id: row.reddit_post_id,
        subreddit: row.subreddit,
        title: row.title,
        body_snippet: row.body_snippet,
        author: row.author,
        permalink: row.permalink,
        upvotes: row.upvotes,
        comment_count: row.comment_count,
        upvote_ratio: row.upvote_ratio,
        ai_quality: row.ai_quality,
        self_promo_risk: row.self_promo_risk ?? "LOW",
        posted_at: row.posted_at,
        fetched_at: row.fetched_at,
        scored_at: row.scored_at,
        engagement_score: engagement,
        display_score: calculateDisplayScore(engagement, row.ai_quality, row.self_promo_risk ?? "LOW"),
        is_available: availability?.isAvailable ?? row.is_available,
        availability_checked_at: availability ? new Date().toISOString() : row.availability_checked_at,
        unavailable_reason: availability ? availability.reason : row.unavailable_reason,
      };
    });

    if (!dryRun && updates.length > 0) {
      for (let i = 0; i < updates.length; i += REBUILD_UPSERT_CHUNK_SIZE) {
        const chunk = updates.slice(i, i + REBUILD_UPSERT_CHUNK_SIZE);
        const { error: upsertError } = await supabase
          .from("signal_posts")
          .upsert(chunk, { onConflict: "reddit_post_id" });

        if (upsertError) throw upsertError;
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      rowsScanned: rows.length,
      unavailablePosts: updates.filter((row) => row.is_available === false).length,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    console.error("signal: rebuild failed:", error);
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "unknown",
      durationMs: Date.now() - start,
    });
  }
}
