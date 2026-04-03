import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import { Resend } from "resend";
import { getSignalConfig } from "@/signal.config";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const blocked = await rateLimit(request, { limit: 5, windowSeconds: 3600 });
  if (blocked) return blocked;

  let email: string;
  try {
    const body = await request.json();
    email = body.email?.trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!email || !EMAIL_REGEX.test(email) || email.length > 320) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const config = getSignalConfig();

  const { data: existing } = await supabase
    .from("signal_subscribers")
    .select("id, confirmed, unsubscribed_at")
    .eq("email", email)
    .maybeSingle();

  if (existing?.confirmed && !existing.unsubscribed_at) {
    return NextResponse.json({ ok: true });
  }

  const { data: subscriber, error: upsertError } = await supabase
    .from("signal_subscribers")
    .upsert(
      {
        email,
        confirmed: false,
        unsubscribed_at: null,
        subscribed_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    )
    .select("confirmation_token")
    .single();

  if (upsertError || !subscriber) {
    console.error("signal: Failed to upsert subscriber:", upsertError);
    return NextResponse.json({ error: "Failed to subscribe" }, { status: 500 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ error: "Email digest is not configured" }, { status: 503 });
  }

  const siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const confirmUrl = `${siteUrl}/api/signal/confirm?token=${subscriber.confirmation_token}`;
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "signal@localhost";

  const resend = new Resend(resendKey);
  const { error: sendError } = await resend.emails.send({
    from: `${config.name} <${fromEmail}>`,
    to: email,
    subject: "Confirm your weekly digest",
    html: `
      <div style="font-family: monospace; max-width: 500px; margin: 0 auto; padding: 32px; background: #0A0A0B; color: #E0E0E0;">
        <h1 style="font-size: 20px; font-weight: bold; margin-bottom: 16px;">Confirm your subscription</h1>
        <p style="font-size: 14px; color: #9A9AAA; line-height: 1.6; margin-bottom: 24px;">
          You signed up for the ${config.name} weekly digest.
        </p>
        <a href="${confirmUrl}" style="display: inline-block; background: #4EC9B0; color: #0A0A0B; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
          Confirm
        </a>
        <p style="font-size: 12px; color: #6A6A7A; margin-top: 24px;">
          If you didn't sign up, you can ignore this email.
        </p>
      </div>
    `,
  });

  if (sendError) {
    console.error("signal: Failed to send confirmation email:", sendError);
    return NextResponse.json({ error: "Failed to send confirmation" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
