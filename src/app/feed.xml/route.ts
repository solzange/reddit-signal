import { createAdminClient } from "@/lib/supabase/admin";
import { FEED_SIZE, WINDOW_HOURS } from "@/lib/signal/config";
import { getSignalConfig } from "@/signal.config";

const config = getSignalConfig();
const siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const supabase = createAdminClient();
  const liveCutoff = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  const { data } = await supabase
    .from("signal_posts")
    .select("title, permalink, subreddit, author, ai_category, ai_summary, posted_at")
    .eq("is_available", true)
    .neq("ai_quality", "LOW")
    .gte("posted_at", liveCutoff)
    .order("display_score", { ascending: false })
    .limit(FEED_SIZE);

  const posts = data ?? [];

  const items = posts
    .map(
      (post) => `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(post.permalink)}</link>
      <description>${escapeXml(post.ai_summary ?? `From r/${post.subreddit}`)}</description>
      <category>${escapeXml(post.ai_category ?? "DISCUSSION")}</category>
      <pubDate>${new Date(post.posted_at).toUTCString()}</pubDate>
      <guid isPermaLink="true">${escapeXml(post.permalink)}</guid>
      <source url="${siteUrl}/feed.xml">${escapeXml(config.name)}</source>
    </item>`
    )
    .join("");

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(config.name)}</title>
    <link>${siteUrl}</link>
    <description>${escapeXml(config.description)}</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml" />
    <ttl>60</ttl>${items}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
