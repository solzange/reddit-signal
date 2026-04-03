import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchAllRedditPosts,
  preFilter,
  scoreAndRank,
  classifyPosts,
  calculateDisplayScore,
  MAX_POSTS_FOR_AI_SCORING,
  buildSourceStateUpsert,
  getSignalSources,
  fetchAvailabilityByRedditIds,
  AVAILABILITY_RECHECK_HOURS,
  materializeSignalArchives,
  publishSignalCurrentSnapshot,
  startSignalRun,
  finishSignalRun,
} from "@/lib/signal";
import { sendSignalAlertOncePerDay } from "@/lib/signal/alerts";
import type { SignalSourceStateRow } from "@/lib/signal/types";

export const maxDuration = 300;
const AI_SCORING_RESERVE_MS = 90_000;
const EXISTING_UPDATE_RESERVE_MS = 20_000;
const NEW_POST_UPSERT_CHUNK_SIZE = 25;

function remainingMs(startTime: number): number {
  return maxDuration * 1000 - (Date.now() - startTime);
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  console.info("signal: Cron started");
  const supabase = createAdminClient();
  const triggerSource = request.headers.get("x-signal-trigger")
    ?? (request.headers.get("x-vercel-cron") ? "vercel-cron" : "manual-http");
  const runId = await startSignalRun(supabase, triggerSource);

  try {
    const selectedSources = getSignalSources(now);
    const sourceKeys = selectedSources.map((source) => source.key);

    const { data: stateRows } = await supabase
      .from("signal_source_state")
      .select(
        "source_key, kind, source_value, last_success_payload, last_success_at, last_attempt_at, last_status, consecutive_failures, cooldown_until"
      )
      .in("source_key", sourceKeys);

    const sourceStateMap = new Map<string, SignalSourceStateRow>(
      ((stateRows ?? []) as SignalSourceStateRow[]).map((row) => [row.source_key, row])
    );

    const runAvailabilityRecheck = async (): Promise<number> => {
      const availabilityCutoff = new Date(
        now.getTime() - AVAILABILITY_RECHECK_HOURS * 3_600_000
      ).toISOString();
      const { data: availabilityCandidates, error: availabilityError } = await supabase
        .from("signal_posts")
        .select("reddit_post_id")
        .eq("is_available", true)
        .gte("posted_at", availabilityCutoff);

      if (availabilityError) {
        console.error("signal: Failed to load availability candidates:", availabilityError);
        return 0;
      }

      const ids = [...new Set((availabilityCandidates ?? []).map((row) => row.reddit_post_id))];
      const availabilityMap = await fetchAvailabilityByRedditIds(ids);
      const availabilityEntries = ids
        .map((id) => ({
          reddit_post_id: id,
          availability: availabilityMap.get(id),
        }))
        .filter(
          (entry): entry is {
            reddit_post_id: string;
            availability: NonNullable<typeof entry.availability>;
          } => Boolean(entry.availability)
        );

      const unavailableIds = availabilityEntries
        .filter((entry) => entry.availability.isAvailable === false)
        .map((entry) => entry.reddit_post_id);

      const updates = availabilityEntries.map(({ reddit_post_id, availability }) => ({
        reddit_post_id,
        is_available: availability.isAvailable,
        availability_checked_at: nowIso,
        unavailable_reason: availability.reason,
      }));

      if (updates.length > 0) {
        const { error } = await supabase
          .from("signal_posts")
          .upsert(updates, { onConflict: "reddit_post_id" });
        if (error) {
          console.error("signal: Failed to persist availability updates:", error);
          return 0;
        }
      }

      return unavailableIds.length;
    };

    // Step 1: Fetch from Reddit
    const fetchResult = await fetchAllRedditPosts(sourceStateMap, now, selectedSources);

    const stateUpserts = fetchResult.sourceResults.map((result) =>
      buildSourceStateUpsert(result, sourceStateMap.get(result.source.key), now)
    );
    if (stateUpserts.length > 0) {
      const { error: stateError } = await supabase
        .from("signal_source_state")
        .upsert(stateUpserts, { onConflict: "source_key" });
      if (stateError) {
        console.error("signal: Failed to persist source state:", stateError);
      }
    }

    const rawPosts = fetchResult.posts;
    if (rawPosts.length === 0) {
      const availabilityHidden = await runAvailabilityRecheck();
      await sendSignalAlertOncePerDay({
        supabase,
        alertKey: "signal_cron_zero_fetched",
        subject: "[Signal Alert] Cron fetched 0 posts",
        lines: [
          "Signal cron fetched zero posts from Reddit/cache.",
          `attempted=${fetchResult.sourcesAttempted}`,
          `succeeded=${fetchResult.sourcesSucceeded}`,
          `blocked=${fetchResult.sourcesBlocked}`,
        ],
      });
      await finishSignalRun(supabase, runId, {
        status: "warning",
        fetchedCount: 0,
        resultMeta: { availabilityHidden, reason: "zero_fetched" },
      });
      return NextResponse.json({ fetched: 0, durationMs: Date.now() - startTime });
    }

    // Step 2: Pre-filter
    const filtered = preFilter(rawPosts);
    console.info(`signal: Pre-filter: ${rawPosts.length} → ${filtered.length} posts`);

    // Step 3: Engagement scoring
    const scored = scoreAndRank(filtered);
    const topPosts = scored.slice(0, MAX_POSTS_FOR_AI_SCORING);
    const postIds = topPosts.map((p) => p.reddit_post_id);

    // Step 4: Check existing AI scores
    const { data: existing, error: lookupError } = await supabase
      .from("signal_posts")
      .select("reddit_post_id, ai_quality, self_promo_risk")
      .in("reddit_post_id", postIds);

    if (lookupError) throw lookupError;

    const existingMap = new Map(
      (existing ?? []).map((e) => [e.reddit_post_id, {
        ai_quality: e.ai_quality as string,
        self_promo_risk: (e.self_promo_risk as string) ?? "LOW",
      }])
    );

    const newPosts = topPosts.filter((p) => !existingMap.has(p.reddit_post_id));
    const existingPosts = topPosts.filter((p) => existingMap.has(p.reddit_post_id));

    // Step 5: AI classify new posts
    let upsertedCount = 0;
    let skippedNewPosts = 0;
    let deferredAiPosts = 0;
    let aiRateLimited = false;
    if (newPosts.length > 0) {
      let postsToClassify = newPosts;
      if (remainingMs(startTime) <= AI_SCORING_RESERVE_MS) {
        skippedNewPosts = newPosts.length;
        postsToClassify = [];
      }

      const classification = postsToClassify.length > 0
        ? await classifyPosts(postsToClassify)
        : { classified: [], deferred: 0, stoppedDueToRateLimit: false };
      const classified = classification.classified;
      deferredAiPosts = classification.deferred;
      aiRateLimited = classification.stoppedDueToRateLimit;

      for (let i = 0; i < classified.length; i += NEW_POST_UPSERT_CHUNK_SIZE) {
        if (remainingMs(startTime) <= EXISTING_UPDATE_RESERVE_MS) break;

        const chunk = classified.slice(i, i + NEW_POST_UPSERT_CHUNK_SIZE);
        const rows = chunk.map((post) => ({
          reddit_post_id: post.reddit_post_id,
          subreddit: post.subreddit,
          title: post.title,
          body_snippet: post.body_snippet || null,
          author: post.author,
          permalink: post.permalink,
          upvotes: post.upvotes,
          comment_count: post.comment_count,
          upvote_ratio: post.upvote_ratio,
          engagement_score: post.engagement_score,
          ai_quality: post.ai_quality,
          ai_category: post.ai_category,
          ai_summary: post.ai_summary || null,
          ai_reasoning: post.ai_reasoning || null,
          self_promo_risk: post.self_promo_risk,
          display_score: calculateDisplayScore(
            post.engagement_score, post.ai_quality, post.self_promo_risk, post.url
          ),
          posted_at: post.posted_at,
          fetched_at: nowIso,
          scored_at: post.scored_at,
          is_available: true,
          availability_checked_at: nowIso,
          unavailable_reason: null,
        }));

        const { error } = await supabase
          .from("signal_posts")
          .upsert(rows, { onConflict: "reddit_post_id" });

        if (error) {
          console.error(`signal: Failed to upsert chunk at ${i}:`, error);
        } else {
          upsertedCount += rows.length;
        }
      }
    }

    // Step 6: Update existing posts
    let updatedCount = 0;
    if (existingPosts.length > 0 && remainingMs(startTime) > EXISTING_UPDATE_RESERVE_MS) {
      const updateRows = existingPosts.map((post) => {
        const existingRow = existingMap.get(post.reddit_post_id);
        const aiQuality = existingRow?.ai_quality ?? "MEDIUM";
        const selfPromoRisk = existingRow?.self_promo_risk ?? "LOW";
        return {
          reddit_post_id: post.reddit_post_id,
          upvotes: post.upvotes,
          comment_count: post.comment_count,
          upvote_ratio: post.upvote_ratio,
          engagement_score: post.engagement_score,
          display_score: calculateDisplayScore(post.engagement_score, aiQuality, selfPromoRisk, post.url),
          fetched_at: nowIso,
          subreddit: post.subreddit,
          title: post.title,
          author: post.author,
          permalink: post.permalink,
          posted_at: post.posted_at,
        };
      });

      const { error } = await supabase
        .from("signal_posts")
        .upsert(updateRows, { onConflict: "reddit_post_id" });

      if (!error) updatedCount = updateRows.length;
    }

    // Step 7: Availability recheck, archives, snapshot
    const availabilityHidden = await runAvailabilityRecheck();
    const archiveDates = [...new Set(rawPosts.map((post) =>
      new Date(post.created_utc * 1000).toISOString().slice(0, 10)
    ))];
    archiveDates.push(nowIso.slice(0, 10));
    archiveDates.push(new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10));
    const archives = await materializeSignalArchives(supabase, archiveDates, nowIso.slice(0, 10));
    const currentSnapshot = await publishSignalCurrentSnapshot(supabase, now);
    const snapshotPostCount = currentSnapshot?.postCount ?? 0;

    const durationMs = Date.now() - startTime;
    await finishSignalRun(supabase, runId, {
      status: filtered.length === 0 || snapshotPostCount === 0 ? "warning" : "success",
      fetchedCount: rawPosts.length,
      filteredCount: filtered.length,
      upsertedCount,
      updatedCount,
      snapshotPostCount,
      sourceStats: {
        attempted: fetchResult.sourcesAttempted,
        succeeded: fetchResult.sourcesSucceeded,
        fallback: fetchResult.sourcesFromFallback,
        blocked: fetchResult.sourcesBlocked,
        rateLimited: fetchResult.sourcesRateLimited,
        errored: fetchResult.sourcesErrored,
      },
    });

    console.info(
      `signal: Done — fetched=${rawPosts.length} filtered=${filtered.length} upserted=${upsertedCount} updated=${updatedCount} snapshot=${snapshotPostCount} duration=${durationMs}ms`
    );

    return NextResponse.json({
      fetched: rawPosts.length,
      filtered: filtered.length,
      upserted: upsertedCount,
      updated: updatedCount,
      snapshotPostCount,
      durationMs,
    });
  } catch (error) {
    console.error("signal: Cron failed:", error);
    await sendSignalAlertOncePerDay({
      supabase,
      alertKey: "signal_cron_failed",
      subject: "[Signal Alert] Cron failed",
      lines: [`error=${error instanceof Error ? error.message : "unknown"}`],
    });
    await finishSignalRun(supabase, runId, {
      status: "failed",
      errorText: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "unknown",
      durationMs: Date.now() - startTime,
    });
  }
}
