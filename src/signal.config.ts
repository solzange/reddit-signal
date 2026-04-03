/**
 * reddit-signal configuration
 *
 * This is the only file you need to edit to make reddit-signal yours.
 * Configure your subreddits, keywords, AI scoring context, and branding.
 *
 * Live example: https://promptbook.gg/signal (vibecoding news)
 */

export interface SignalConfig {
  /** Display name for your feed */
  name: string;
  /** One-line description */
  description: string;

  /** Subreddits to monitor */
  subreddits: {
    /** Always fetched every run */
    core: Array<{ name: string; minScore?: number; communitySize?: number }>;
    /** Rotated daily (2 per run) to reduce API calls */
    rotating?: Array<{ name: string; minScore?: number; communitySize?: number }>;
  };

  /** Keyword searches (catches posts in any subreddit) */
  keywords?: string[];

  /**
   * AI scoring context — tells the AI model what "good" means for YOUR community.
   * If omitted or no AI_API_KEY is set, posts are ranked by engagement score only.
   */
  communityContext?: string;

  /** Feed tuning */
  feedSize?: number;         // posts per page (default: 9)
  windowHours?: number;      // how far back to look (default: 24)
  maxPerSubreddit?: number;  // diversity cap per sub (default: 3)
  maxPerCategory?: number;   // diversity cap per AI category (default: 4)

  /** Branding */
  siteUrl?: string;          // your deployed URL (default: from NEXT_PUBLIC_SITE_URL env)
}

/**
 * ============================================================================
 * EDIT BELOW — configure your feed
 * ============================================================================
 */

const config: SignalConfig = {
  name: "Reddit Signal",
  description: "AI-curated Reddit feed, updated every 15 minutes.",

  subreddits: {
    core: [
      { name: "vibecoding", minScore: 8 },
      { name: "ClaudeAI", minScore: 15, communitySize: 80_000 },
      { name: "cursor", minScore: 10, communitySize: 60_000 },
    ],
    rotating: [
      { name: "ChatGPTCoding", minScore: 10, communitySize: 50_000 },
      { name: "LocalLLaMA", minScore: 20, communitySize: 300_000 },
    ],
  },

  keywords: [
    "vibecoding",
    "claude code",
    "cursor ai",
  ],

  communityContext: `You are curating a feed for developers who build software with AI coding assistants
(Claude Code, Cursor, Copilot, Replit, Lovable, etc.).

Value: tutorials with code, tool comparisons with data, reproducible techniques, workflow insights.
Penalize: drama, gossip, pricing complaints, vague questions, pure self-promotion without substance.

A post being highly upvoted does NOT make it high quality. Relevance and usefulness matter more.`,

  feedSize: 9,
  windowHours: 24,
  maxPerSubreddit: 3,
  maxPerCategory: 4,
};

export function getSignalConfig(): SignalConfig {
  return config;
}
