import type { SupabaseClient } from "@supabase/supabase-js";
import { FEED_SIZE, WINDOW_HOURS } from "./config";
import { selectFeedPosts } from "./diversity";
import type { SignalPost } from "./types";

const SIGNAL_POST_SELECT =
  "id, reddit_post_id, subreddit, title, body_snippet, author, permalink, upvotes, comment_count, upvote_ratio, ai_quality, ai_category, ai_summary, ai_reasoning, self_promo_risk, boost_count, display_score, engagement_score, posted_at, fetched_at, scored_at, is_available, availability_checked_at, unavailable_reason";

const LIVE_SNAPSHOT_KEY = "live";

export interface SignalCurrentSnapshot {
  snapshotKey: string;
  posts: SignalPost[];
  postCount: number;
  sourceLastRefresh: string | null;
  publishedAt: string;
  windowHours: number;
  buildMeta: Record<string, unknown> | null;
}

function getLatestRefresh(posts: SignalPost[]): string | null {
  if (posts.length === 0) return null;
  return posts.reduce(
    (latest, post) => (post.fetched_at > latest ? post.fetched_at : latest),
    posts[0].fetched_at
  );
}

export async function buildSignalCurrentSnapshot(
  supabase: SupabaseClient,
  now = new Date(),
  windowHours = WINDOW_HOURS
): Promise<Omit<SignalCurrentSnapshot, "publishedAt"> | null> {
  const liveCutoff = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("signal_posts")
    .select(SIGNAL_POST_SELECT)
    .eq("is_available", true)
    .neq("ai_quality", "LOW")
    .gte("posted_at", liveCutoff)
    .order("display_score", { ascending: false })
    .order("engagement_score", { ascending: false })
    .limit(FEED_SIZE * 5);

  if (error) throw error;

  const rows = (data ?? []) as SignalPost[];
  if (rows.length === 0) return null;

  const posts = selectFeedPosts(rows, FEED_SIZE);
  if (posts.length === 0) return null;

  return {
    snapshotKey: LIVE_SNAPSHOT_KEY,
    posts,
    postCount: posts.length,
    sourceLastRefresh: getLatestRefresh(posts),
    windowHours,
    buildMeta: { strategy: "rolling_live_window", built_from: "signal_posts" },
  };
}

export async function publishSignalCurrentSnapshot(
  supabase: SupabaseClient,
  now = new Date(),
  windowHours = WINDOW_HOURS
): Promise<SignalCurrentSnapshot | null> {
  const snapshot = await buildSignalCurrentSnapshot(supabase, now, windowHours);
  if (!snapshot) return null;

  const publishedAt = new Date().toISOString();
  const { error } = await supabase
    .from("signal_current_snapshot")
    .upsert(
      {
        snapshot_key: snapshot.snapshotKey,
        posts: snapshot.posts,
        post_count: snapshot.postCount,
        source_last_refresh: snapshot.sourceLastRefresh,
        published_at: publishedAt,
        window_hours: snapshot.windowHours,
        build_meta: snapshot.buildMeta,
      },
      { onConflict: "snapshot_key" }
    );

  if (error) throw error;
  return { ...snapshot, publishedAt };
}

export async function getCurrentSignalSnapshot(
  supabase: SupabaseClient,
  snapshotKey = LIVE_SNAPSHOT_KEY
): Promise<SignalCurrentSnapshot | null> {
  const { data, error } = await supabase
    .from("signal_current_snapshot")
    .select("snapshot_key, posts, post_count, source_last_refresh, published_at, window_hours, build_meta")
    .eq("snapshot_key", snapshotKey)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    snapshotKey: data.snapshot_key,
    posts: (data.posts ?? []) as SignalPost[],
    postCount: data.post_count ?? 0,
    sourceLastRefresh: data.source_last_refresh,
    publishedAt: data.published_at,
    windowHours: data.window_hours ?? WINDOW_HOURS,
    buildMeta: (data.build_meta as Record<string, unknown> | null) ?? null,
  };
}
