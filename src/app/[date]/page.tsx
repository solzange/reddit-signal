import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSignalArchiveSnapshot } from "@/lib/signal";
import { getSignalConfig } from "@/signal.config";
import { SignalClient } from "../signal-client";

export const dynamic = "force-dynamic";

const config = getSignalConfig();
const siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().startsWith(dateStr);
}

type Props = {
  params: Promise<{ date: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { date } = await params;
  const formatted = isValidDate(date) ? formatDate(date) : date;

  return {
    title: `${config.name} — ${formatted}`,
    description: `${config.description} Archive for ${formatted}.`,
    alternates: { canonical: `${siteUrl}/${date}` },
  };
}

export default async function SignalArchivePage({ params }: Props) {
  const { date } = await params;

  if (!isValidDate(date)) notFound();
  if (date > new Date().toISOString().slice(0, 10)) notFound();

  const supabase = createAdminClient();
  const snapshot = await getSignalArchiveSnapshot(supabase, date);

  if (!snapshot || snapshot.posts.length === 0) notFound();

  return (
    <Suspense>
      <SignalClient
        initialPosts={snapshot.posts}
        initialNextPage={null}
        lastRefresh={snapshot.sourceLastRefresh}
        archiveDate={date}
        emailSignupEnabled={false}
      />
    </Suspense>
  );
}
