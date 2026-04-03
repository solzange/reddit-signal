"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FEED_SIZE } from "@/lib/signal/config";
import { relativeTime } from "@/lib/time";
import type { AiCategory } from "@/lib/signal/types";

interface SignalPost {
  id: string;
  reddit_post_id: string;
  subreddit: string;
  title: string;
  body_snippet: string | null;
  author: string;
  permalink: string;
  upvotes: number;
  comment_count: number;
  ai_quality: string;
  ai_category: AiCategory | null;
  ai_summary: string | null;
  ai_reasoning: string | null;
  boost_count: number;
  display_score: number;
  posted_at: string;
  fetched_at: string;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  TUTORIAL: { bg: "bg-accent-function/15", text: "text-accent-function" },
  TOOL: { bg: "bg-accent-primary/15", text: "text-accent-primary" },
  INSIGHT: { bg: "bg-accent-constant/15", text: "text-accent-constant" },
  SHOWCASE: { bg: "bg-accent-string/15", text: "text-accent-string" },
  DISCUSSION: { bg: "bg-accent-keyword/15", text: "text-accent-keyword" },
  META: { bg: "bg-accent-comment/15", text: "text-accent-comment" },
};

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function formatRefreshFriendly(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return "Refreshed just now";
  if (hours === 1) return "Refreshed 1h ago";
  if (hours < 24) return `Refreshed ${hours}h ago`;
  return `Refreshed ${Math.floor(hours / 24)}d ago`;
}

function formatArchiveDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function getAdjacentDate(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface Props {
  initialPosts: SignalPost[];
  initialNextPage: number | null;
  lastRefresh: string | null;
  archiveDate?: string;
  fallbackSnapshotDate?: string | null;
  emailSignupEnabled?: boolean;
}

export function SignalClient({
  initialPosts,
  initialNextPage,
  lastRefresh,
  archiveDate,
  fallbackSnapshotDate,
  emailSignupEnabled = false,
}: Props) {
  const [posts, setPosts] = useState<SignalPost[]>(initialPosts);
  const [nextPage, setNextPage] = useState<number | null>(initialNextPage);
  const [loadingMore, setLoadingMore] = useState(false);

  const [boostedIds, setBoostedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("signal-boosts");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const handleBoost = useCallback(async (postId: string) => {
    if (boostedIds.has(postId)) return;

    setBoostedIds((prev) => {
      const next = new Set(prev);
      next.add(postId);
      try { localStorage.setItem("signal-boosts", JSON.stringify([...next])); } catch {}
      return next;
    });
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId ? { ...p, boost_count: p.boost_count + 1 } : p
      )
    );

    try {
      const res = await fetch("/api/signal/boost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId }),
      });
      if (!res.ok && res.status !== 409) {
        setBoostedIds((prev) => {
          const next = new Set(prev);
          next.delete(postId);
          try { localStorage.setItem("signal-boosts", JSON.stringify([...next])); } catch {}
          return next;
        });
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId ? { ...p, boost_count: Math.max(0, p.boost_count - 1) } : p
          )
        );
      }
    } catch {
      setBoostedIds((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        try { localStorage.setItem("signal-boosts", JSON.stringify([...next])); } catch {}
        return next;
      });
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, boost_count: Math.max(0, p.boost_count - 1) } : p
        )
      );
    }
  }, [boostedIds]);

  const handleLoadMore = async () => {
    if (!nextPage || loadingMore) return;
    setLoadingMore(true);
    const res = await fetch(`/api/signal?page=${nextPage}`);
    if (res.ok) {
      const data = await res.json();
      setPosts((prev) => [...prev, ...data.posts]);
      setNextPage(data.nextPage);
    }
    setLoadingMore(false);
  };

  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-bold leading-snug text-text-primary sm:text-2xl">
          Today&apos;s best posts from Reddit.
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-text-tertiary">
          {archiveDate
            ? `${formatArchiveDate(archiveDate)} · AI-ranked, no slop, no self-promo.`
            : "AI-ranked from the latest successful refresh. No slop, no self-promo."}
        </p>
        {lastRefresh && !archiveDate && (
          <p className="mt-2 text-xs text-text-tertiary" suppressHydrationWarning>
            {formatRefreshFriendly(lastRefresh)}
          </p>
        )}
        {fallbackSnapshotDate && !archiveDate && (
          <p className="mt-2 text-xs text-accent-primary">
            No current snapshot is published. Showing the latest archive from{" "}
            <Link href={`/${fallbackSnapshotDate}`} className="underline hover:no-underline">
              {formatArchiveDate(fallbackSnapshotDate)}
            </Link>
            .
          </p>
        )}

        {archiveDate && (
          <div className="mt-3 flex items-center gap-3 text-xs">
            <Link
              href={`/${getAdjacentDate(archiveDate, -1)}`}
              className="text-accent-primary hover:underline"
            >
              &larr; Previous day
            </Link>
            <span className="text-text-tertiary">|</span>
            {getAdjacentDate(archiveDate, 1) <= new Date().toISOString().slice(0, 10) ? (
              <Link
                href={
                  getAdjacentDate(archiveDate, 1) === new Date().toISOString().slice(0, 10)
                    ? "/"
                    : `/${getAdjacentDate(archiveDate, 1)}`
                }
                className="text-accent-primary hover:underline"
              >
                Next day &rarr;
              </Link>
            ) : (
              <span className="text-text-tertiary">Next day &rarr;</span>
            )}
            <span className="text-text-tertiary">|</span>
            <Link href="/" className="text-accent-primary hover:underline">
              Today
            </Link>
          </div>
        )}

        {!archiveDate && posts.length > 0 && (
          <div className="mt-3 flex items-center gap-3 text-xs">
            <Link
              href={`/${getAdjacentDate(new Date().toISOString().slice(0, 10), -1)}`}
              className="text-accent-primary hover:underline"
            >
              &larr; Yesterday
            </Link>
            <span className="text-text-tertiary">|</span>
            <span className="text-text-tertiary">Today</span>
          </div>
        )}
      </div>

      {/* Email signup */}
      {!archiveDate && emailSignupEnabled && <EmailSignup />}

      {/* Posts */}
      {posts.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-text-secondary">No posts yet.</p>
          <p className="mt-1 text-xs text-text-tertiary">
            Feed refreshes every 15 minutes. Check back later.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {posts.map((post, index) => (
            <PostCard
              key={post.id}
              post={post}
              rank={index + 1}
              featured={index < 3}
              boosted={boostedIds.has(post.id)}
              onBoost={() => handleBoost(post.id)}
            />
          ))}

          {posts.length > 0 && posts.length < FEED_SIZE && (
            <div className="rounded-lg border border-dashed border-border-subtle bg-bg-surface px-4 py-3 text-sm text-text-secondary">
              Quiet day. We found {posts.length} worth keeping and left the filler on Reddit.
            </div>
          )}
        </div>
      )}

      {nextPage && (
        <div className="mt-6 text-center">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-elevated disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}

      {!nextPage && posts.length > 0 && (
        <div className="mt-8 border-t border-border-subtle pt-6 text-center">
          <p className="text-xs text-text-tertiary">
            That&apos;s everything worth reading today. Back tomorrow.
          </p>
        </div>
      )}

      <FeedbackForm />

      {/* Powered by reddit-signal */}
      <div className="mt-8 text-center">
        <p className="text-xs text-text-tertiary">
          Powered by{" "}
          <a
            href="https://github.com/solzange/reddit-signal"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-primary hover:underline"
          >
            reddit-signal
          </a>
          {" · "}
          <a
            href="https://promptbook.gg/signal"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-tertiary hover:text-text-secondary"
          >
            See it in action
          </a>
        </p>
      </div>
    </>
  );
}

function PostCard({
  post,
  rank,
  featured,
  boosted,
  onBoost,
}: {
  post: SignalPost;
  rank: number;
  featured: boolean;
  boosted: boolean;
  onBoost: () => void;
}) {
  const cat = CATEGORY_COLORS[post.ai_category ?? ""] ?? {
    bg: "bg-bg-elevated",
    text: "text-text-tertiary",
  };

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        featured
          ? "border-accent-primary/20 bg-bg-surface"
          : "border-border-subtle bg-bg-surface"
      }`}
    >
      <h3
        className={`leading-snug ${
          featured
            ? "text-[15px] font-semibold text-text-primary"
            : "text-sm font-medium text-text-primary"
        }`}
      >
        {post.title}
      </h3>

      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-text-tertiary">
        <span className={`font-bold ${featured ? "text-accent-primary" : "text-text-tertiary"}`}>
          #{rank}
        </span>
        {post.ai_category && (
          <span
            className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider ${cat.bg} ${cat.text}`}
          >
            {post.ai_category}
          </span>
        )}
        <span>r/{post.subreddit}</span>
        <span>·</span>
        <span suppressHydrationWarning>{relativeTime(post.posted_at)}</span>
      </div>

      {post.ai_summary && (
        <p className="mt-2 border-l-2 border-accent-primary/30 pl-2.5 text-xs leading-relaxed text-text-secondary">
          {post.ai_summary}
        </p>
      )}

      {featured && post.ai_reasoning && (
        <p className="mt-1.5 text-[11px] italic text-text-tertiary">
          <span className="not-italic font-medium text-text-tertiary">Why this made the cut:</span>{" "}
          {post.ai_reasoning}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-3 text-[11px] text-text-tertiary">
        <span className="group relative">
          <button
            onClick={onBoost}
            disabled={boosted}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
              boosted
                ? "text-accent-primary"
                : "text-text-tertiary hover:text-accent-primary hover:bg-accent-primary/10"
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill={boosted ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
            </svg>
            {post.boost_count > 0 && <span>{post.boost_count}</span>}
          </button>
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
          {formatNumber(post.upvotes)}
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          {post.comment_count}
        </span>
        <span className="ml-auto">
          <a
            href={post.permalink}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-accent-primary transition-colors"
          >
            Reddit
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        </span>
      </div>
    </div>
  );
}

function FeedbackForm() {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const handleSubmit = async () => {
    if (!message.trim() || status === "sending") return;
    setStatus("sending");
    try {
      const res = await fetch("/api/signal/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (res.ok) {
        setStatus("sent");
        setMessage("");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <div className="mt-6 text-center text-xs text-text-tertiary">
        Thanks — we&apos;ll look into it.
      </div>
    );
  }

  return (
    <div className="mt-6">
      <p className="mb-2 text-xs text-text-tertiary">
        Missing something good? Send it our way.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="Paste a Reddit URL or tell us what we missed"
          maxLength={500}
          className="flex-1 rounded-lg border border-border-input bg-bg-base px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:outline-none"
        />
        <button
          onClick={handleSubmit}
          disabled={!message.trim() || status === "sending"}
          className="shrink-0 rounded-lg bg-bg-elevated px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-overlay hover:text-text-primary disabled:opacity-50"
        >
          {status === "sending" ? "..." : "Send"}
        </button>
      </div>
      {status === "error" && (
        <p className="mt-1 text-xs text-accent-error">Failed to send. Try again.</p>
      )}
    </div>
  );
}

function EmailSignup() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const searchParams = useSearchParams();
  const justSubscribed = searchParams.get("subscribed") === "1";

  if (justSubscribed || status === "sent") {
    return (
      <div className="mb-6 rounded-lg border border-accent-primary/20 bg-accent-primary/5 px-4 py-3 text-center text-sm text-accent-primary">
        {justSubscribed
          ? "You're subscribed — see you Monday."
          : "Check your inbox — confirmation link waiting."}
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!email.trim() || status === "sending") return;
    setStatus("sending");
    try {
      const res = await fetch("/api/signal/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.ok) {
        setStatus("sent");
        setEmail("");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="mb-6 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
      <p className="mb-2 text-xs text-text-secondary">
        Get the weekly digest every Monday — the best posts, no inbox noise.
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="you@email.com"
          className="min-w-0 flex-1 rounded-lg border border-border-input bg-bg-base px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:outline-none"
        />
        <button
          onClick={handleSubmit}
          disabled={!email.trim() || status === "sending"}
          className="shrink-0 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-text-inverse transition-colors hover:bg-accent-primary-muted disabled:opacity-50"
        >
          {status === "sending" ? "..." : "Subscribe"}
        </button>
      </div>
      {status === "error" && (
        <p className="mt-1 text-xs text-accent-error">Failed to subscribe. Try again.</p>
      )}
    </div>
  );
}
