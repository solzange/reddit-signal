import type { SupabaseClient } from "@supabase/supabase-js";
import { FEED_SIZE } from "./config";
import { selectFeedPosts } from "./diversity";
import type { SignalPost } from "./types";

const SIGNAL_POST_SELECT =
  "id, reddit_post_id, subreddit, title, body_snippet, author, permalink, upvotes, comment_count, upvote_ratio, ai_quality, ai_category, ai_summary, ai_reasoning, self_promo_risk, boost_count, display_score, engagement_score, posted_at, fetched_at, scored_at, is_available, availability_checked_at, unavailable_reason";

export interface SignalArchiveSnapshot {
  archiveDate: string;
  posts: SignalPost[];
  postCount: number;
  sourceLastRefresh: string | null;
  generatedAt?: string;
}

type SignalAdminClient = SupabaseClient;

function getUtcDateBounds(archiveDate: string) {
  const start = new Date(`${archiveDate}T00:00:00Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function getLatestRefresh(posts: SignalPost[]): string | null {
  if (posts.length === 0) return null;
  return posts.reduce(
    (latest, post) => (post.fetched_at > latest ? post.fetched_at : latest),
    posts[0].fetched_at
  );
}

export async function buildSignalArchiveSnapshot(
  supabase: SignalAdminClient,
  archiveDate: string
): Promise<SignalArchiveSnapshot | null> {
  const { start, end } = getUtcDateBounds(archiveDate);
  const { data, error } = await supabase
    .from("signal_posts")
    .select(SIGNAL_POST_SELECT)
    .eq("is_available", true)
    .gte("posted_at", start)
    .lt("posted_at", end)
    .order("display_score", { ascending: false })
    .order("engagement_score", { ascending: false })
    .limit(FEED_SIZE * 5);

  if (error) throw error;

  const rows = (data ?? []) as SignalPost[];
  if (rows.length === 0) return null;

  const posts = selectFeedPosts(rows, FEED_SIZE);

  return {
    archiveDate,
    posts,
    postCount: posts.length,
    sourceLastRefresh: getLatestRefresh(posts),
  };
}

export async function upsertSignalArchiveSnapshot(
  supabase: SignalAdminClient,
  snapshot: SignalArchiveSnapshot
) {
  const { error } = await supabase
    .from("signal_daily_archives")
    .upsert(
      {
        archive_date: snapshot.archiveDate,
        posts: snapshot.posts,
        post_count: snapshot.postCount,
        source_last_refresh: snapshot.sourceLastRefresh,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "archive_date" }
    );

  if (error) throw error;
}

export async function getSignalArchiveSnapshot(
  supabase: SignalAdminClient,
  archiveDate: string
): Promise<SignalArchiveSnapshot | null> {
  const { data, error } = await supabase
    .from("signal_daily_archives")
    .select("archive_date, posts, post_count, source_last_refresh, generated_at")
    .eq("archive_date", archiveDate)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    archiveDate: data.archive_date,
    posts: ((data.posts ?? []) as SignalPost[]),
    postCount: data.post_count ?? 0,
    sourceLastRefresh: data.source_last_refresh,
    generatedAt: data.generated_at,
  };
}

export async function getLatestSignalArchiveSnapshot(
  supabase: SignalAdminClient
): Promise<SignalArchiveSnapshot | null> {
  const { data, error } = await supabase
    .from("signal_daily_archives")
    .select("archive_date, posts, post_count, source_last_refresh, generated_at")
    .order("archive_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    archiveDate: data.archive_date,
    posts: ((data.posts ?? []) as SignalPost[]),
    postCount: data.post_count ?? 0,
    sourceLastRefresh: data.source_last_refresh,
    generatedAt: data.generated_at,
  };
}

export async function materializeSignalArchives(
  supabase: SignalAdminClient,
  archiveDates: string[],
  todayDate: string
) {
  const uniqueDates = [...new Set(archiveDates)].sort();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const archiveDate of uniqueDates) {
    const isToday = archiveDate === todayDate;

    if (!isToday) {
      const { data, error } = await supabase
        .from("signal_daily_archives")
        .select("archive_date")
        .eq("archive_date", archiveDate)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        skipped++;
        continue;
      }
    }

    const snapshot = await buildSignalArchiveSnapshot(supabase, archiveDate);
    if (!snapshot) continue;

    await upsertSignalArchiveSnapshot(supabase, snapshot);
    if (isToday) updated++;
    else created++;
  }

  return { created, updated, skipped };
}
