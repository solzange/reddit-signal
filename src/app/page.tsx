import type { Metadata } from "next";
import { Suspense } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentSignalSnapshot, getLatestSignalArchiveSnapshot } from "@/lib/signal";
import { getSignalConfig } from "@/signal.config";
import { SignalClient } from "./signal-client";

export const dynamic = "force-dynamic";

const config = getSignalConfig();
const siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: config.name,
  description: config.description,
  alternates: {
    canonical: siteUrl,
    types: {
      "application/rss+xml": `${siteUrl}/feed.xml`,
    },
  },
  openGraph: {
    title: config.name,
    description: config.description,
    url: siteUrl,
  },
};

export default async function SignalPage() {
  const supabase = createAdminClient();
  const currentSnapshot = await getCurrentSignalSnapshot(supabase);
  let items = currentSnapshot?.posts ?? [];
  const hasMore = false;
  let lastRefresh = currentSnapshot?.sourceLastRefresh ?? null;
  let fallbackSnapshotDate: string | null = null;
  const emailSignupEnabled = Boolean(process.env.RESEND_API_KEY);

  if (items.length === 0) {
    const snapshot = await getLatestSignalArchiveSnapshot(supabase);
    if (snapshot && snapshot.posts.length > 0) {
      items = snapshot.posts;
      lastRefresh = snapshot.sourceLastRefresh;
      fallbackSnapshotDate = snapshot.archiveDate;
    }
  }

  return (
    <Suspense>
      <SignalClient
        initialPosts={items}
        initialNextPage={hasMore ? 2 : null}
        lastRefresh={lastRefresh}
        fallbackSnapshotDate={fallbackSnapshotDate}
        emailSignupEnabled={emailSignupEnabled}
      />
    </Suspense>
  );
}
