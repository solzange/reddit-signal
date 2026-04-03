import type { SupabaseClient } from "@supabase/supabase-js";

type SignalRunStatus = "running" | "success" | "warning" | "failed";
const STALE_SIGNAL_RUN_MINUTES = 15;

type FinishSignalRunOptions = {
  status: SignalRunStatus;
  fetchedCount?: number;
  filteredCount?: number;
  upsertedCount?: number;
  updatedCount?: number;
  snapshotPostCount?: number;
  sourceStats?: Record<string, unknown>;
  resultMeta?: Record<string, unknown>;
  errorText?: string | null;
};

export async function startSignalRun(
  supabase: SupabaseClient,
  triggerSource: string
): Promise<number | null> {
  const staleCutoff = new Date(Date.now() - STALE_SIGNAL_RUN_MINUTES * 60_000).toISOString();
  const { error: cleanupError } = await supabase
    .from("signal_pipeline_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_text: "Marked failed automatically after exceeding the stale run threshold",
    })
    .eq("status", "running")
    .lt("started_at", staleCutoff);

  if (cleanupError) {
    console.error("signal: Failed to clean up stale pipeline runs:", cleanupError);
  }

  const { data, error } = await supabase
    .from("signal_pipeline_runs")
    .insert({ trigger_source: triggerSource, status: "running" })
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("signal: Failed to start pipeline run record:", error);
    return null;
  }

  return data?.id ?? null;
}

export async function finishSignalRun(
  supabase: SupabaseClient,
  runId: number | null,
  {
    status,
    fetchedCount = 0,
    filteredCount = 0,
    upsertedCount = 0,
    updatedCount = 0,
    snapshotPostCount = 0,
    sourceStats,
    resultMeta,
    errorText = null,
  }: FinishSignalRunOptions
) {
  if (!runId) return;

  const { error } = await supabase
    .from("signal_pipeline_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      fetched_count: fetchedCount,
      filtered_count: filteredCount,
      upserted_count: upsertedCount,
      updated_count: updatedCount,
      snapshot_post_count: snapshotPostCount,
      source_stats: sourceStats ?? null,
      result_meta: resultMeta ?? null,
      error_text: errorText,
    })
    .eq("id", runId);

  if (error) {
    console.error(`signal: Failed to finish pipeline run ${runId}:`, error);
  }
}
