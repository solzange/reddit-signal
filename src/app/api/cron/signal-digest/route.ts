import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Resend } from "resend";
import { selectWeeklyPosts } from "@/lib/signal";
import { sendSignalAlertOncePerDay } from "@/lib/signal/alerts";
import { getSignalConfig } from "@/signal.config";

export const maxDuration = 60;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDigestHtml(
  posts: Array<{
    title: string;
    permalink: string;
    ai_summary: string | null;
    ai_category: string | null;
    subreddit: string;
    upvotes: number;
  }>,
  weekRange: string,
  unsubscribeUrl: string,
  feedName: string,
  siteUrl: string
): string {
  const postRows = posts
    .map(
      (post, i) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1A1A1F">
          <div style="font-size:11px;color:#6A6A7A;margin-bottom:4px">
            #${i + 1} · r/${escapeHtml(post.subreddit)} · ${post.upvotes} upvotes${post.ai_category ? ` · ${escapeHtml(post.ai_category)}` : ""}
          </div>
          <a href="${escapeHtml(post.permalink)}" style="color:#E0E0E0;text-decoration:none;font-size:14px;font-weight:600;line-height:1.4" target="_blank">
            ${escapeHtml(post.title)}
          </a>
          ${post.ai_summary ? `<div style="font-size:13px;color:#9A9AAA;margin-top:6px;line-height:1.5;border-left:2px solid #4EC9B040;padding-left:10px">${escapeHtml(post.ai_summary)}</div>` : ""}
        </td>
      </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0A0A0B;font-family:monospace">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px">
    <div style="margin-bottom:32px">
      <h1 style="font-size:24px;color:#E0E0E0;margin:0;font-weight:bold">${escapeHtml(feedName)}</h1>
      <div style="font-size:13px;color:#6A6A7A;margin-top:4px">${weekRange}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      ${postRows}
    </table>
    <div style="margin-top:32px;font-size:11px;color:#6A6A7A;text-align:center;line-height:1.6">
      <a href="${siteUrl}" style="color:#4EC9B0;text-decoration:none">View on web</a>
      &nbsp;·&nbsp;
      <a href="${unsubscribeUrl}" style="color:#6A6A7A;text-decoration:none">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ error: "Email not configured" }, { status: 500 });
  }

  const supabase = createAdminClient();
  const config = getSignalConfig();
  const siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "signal@localhost";

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: rawPosts } = await supabase
      .from("signal_posts")
      .select("title, permalink, ai_summary, ai_category, ai_quality, subreddit, upvotes")
      .eq("is_available", true)
      .neq("ai_quality", "LOW")
      .gte("posted_at", weekAgo)
      .order("display_score", { ascending: false })
      .order("engagement_score", { ascending: false })
      .limit(45);

    const posts = selectWeeklyPosts(rawPosts ?? [], 15);

    if (!posts || posts.length === 0) {
      return NextResponse.json({ sent: 0, reason: "no posts" });
    }

    const { data: subscribers } = await supabase
      .from("signal_subscribers")
      .select("email, confirmation_token")
      .eq("confirmed", true)
      .is("unsubscribed_at", null);

    if (!subscribers || subscribers.length === 0) {
      return NextResponse.json({ sent: 0, reason: "no subscribers" });
    }

    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const weekRange = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

    const resend = new Resend(resendKey);
    let sentCount = 0;

    for (let i = 0; i < subscribers.length; i += 50) {
      const batch = subscribers.slice(i, i + 50);

      const emails = batch.map((sub) => ({
        from: `${config.name} <${fromEmail}>`,
        to: sub.email,
        subject: `${config.name} — ${weekRange}`,
        html: buildDigestHtml(
          posts,
          weekRange,
          `${siteUrl}/api/signal/unsubscribe?token=${sub.confirmation_token}`,
          config.name,
          siteUrl
        ),
      }));

      try {
        await resend.batch.send(emails);
        sentCount += batch.length;
      } catch (err) {
        console.error(`signal-digest: Batch send failed at offset ${i}:`, err);
      }
    }

    console.info(`signal-digest: Sent ${sentCount} emails with ${posts.length} posts`);
    return NextResponse.json({ sent: sentCount, posts: posts.length, weekRange });
  } catch (error) {
    console.error("signal-digest: Digest failed:", error);
    await sendSignalAlertOncePerDay({
      supabase,
      alertKey: "signal_digest_failed",
      subject: "[Signal Alert] Weekly digest failed",
      lines: [`error=${error instanceof Error ? error.message : "unknown"}`],
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}
