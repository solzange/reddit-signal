import { Resend } from "resend";
import type { SupabaseClient } from "@supabase/supabase-js";

const ALERT_THROTTLE_MS = 24 * 3_600_000;

type AlertOptions = {
  supabase: SupabaseClient;
  alertKey: string;
  subject: string;
  lines: string[];
};

export async function sendSignalAlertOncePerDay({
  supabase,
  alertKey,
  subject,
  lines,
}: AlertOptions): Promise<boolean> {
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return false;

    const toEmail = process.env.SIGNAL_ALERT_EMAIL;
    if (!toEmail) return false;

    const fromEmail = process.env.RESEND_FROM_EMAIL ?? "signal@localhost";
    const sourceKey = `alert:${alertKey}`;

    const { data: existing, error: lookupError } = await supabase
      .from("signal_source_state")
      .select("last_success_at")
      .eq("source_key", sourceKey)
      .maybeSingle();

    if (lookupError) {
      console.error(`signal-alert: failed to load alert state for ${alertKey}:`, lookupError);
      return false;
    }

    if (existing?.last_success_at) {
      const elapsedMs = Date.now() - new Date(existing.last_success_at).getTime();
      if (elapsedMs < ALERT_THROTTLE_MS) return false;
    }

    const resend = new Resend(resendKey);
    const text = lines.join("\n");

    await resend.emails.send({
      from: `Signal Alerts <${fromEmail}>`,
      to: toEmail,
      subject,
      text,
    });

    const { error: upsertError } = await supabase
      .from("signal_source_state")
      .upsert(
        {
          source_key: sourceKey,
          kind: "keyword",
          source_value: alertKey,
          last_success_payload: { subject, lines },
          last_success_at: new Date().toISOString(),
          last_attempt_at: new Date().toISOString(),
          last_status: "success",
          consecutive_failures: 0,
          cooldown_until: null,
        },
        { onConflict: "source_key" }
      );

    if (upsertError) {
      console.error(`signal-alert: failed to persist alert state for ${alertKey}:`, upsertError);
    }

    return true;
  } catch (error) {
    console.error(`signal-alert: failed to send ${alertKey}:`, error);
    return false;
  }
}
