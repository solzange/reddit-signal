# reddit-signal

Your own AI-curated Reddit feed for any topic. Self-hosted on Cloudflare Workers + Supabase + Vercel (all free tier). Optional AI scoring via any LLM.

**[See it live](https://promptbook.gg/signal)** — a vibecoding news feed powered by reddit-signal.

## What it does

reddit-signal monitors subreddits and keyword searches every 15 minutes, scores posts by engagement, optionally classifies them with AI, and serves a curated feed on a clean dark-themed page.

- **Engagement scoring** — HN-style algorithm with community-size normalization, comment boost, controversy penalty
- **AI classification** (optional) — quality tiers, categories, summaries, self-promo detection
- **Source resilience** — cached fallbacks, cooldowns, failure tracking
- **Daily archives** — browse any past day's feed
- **Weekly email digest** — via Resend (optional)
- **RSS feed** — at `/feed.xml`
- **Anonymous boosts** — IP-hashed upvotes, no auth required
- **Feedback form** — visitors can suggest posts

## How it works

```
Cloudflare Worker (cron every 15 min)
  → Queue message → Worker consumer
    → GET /api/cron/signal on your Vercel app
      → Fetch Reddit (via Cloudflare reddit-proxy)
      → Pre-filter (ratio, comments, deleted)
      → Engagement scoring
      → AI classification (optional, if AI_API_KEY set)
      → Upsert to Supabase
      → Publish live snapshot
      → Materialize daily archive
```

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/solzange/reddit-signal.git
cd reddit-signal
npm install
```

### 2. Set up Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run the contents of `supabase/migrations/001_init.sql`
3. Copy your project URL and service role key

### 3. Configure your feed

Edit `src/signal.config.ts` — this is the only file you need to change:

```ts
const config: SignalConfig = {
  name: "My AI Feed",
  description: "The best AI posts from Reddit.",

  subreddits: {
    core: [
      { name: "MachineLearning", minScore: 20, communitySize: 300_000 },
      { name: "LocalLLaMA", minScore: 15, communitySize: 300_000 },
    ],
    rotating: [
      { name: "artificial", minScore: 10, communitySize: 100_000 },
    ],
  },

  keywords: ["LLM", "transformer model"],

  communityContext: `You are curating a feed for ML researchers and practitioners.
Value: papers with code, benchmark results, novel architectures.
Penalize: hype, speculation, product launches without technical depth.`,
};
```

### 4. Set up environment

```bash
cp .env.example .env
```

Fill in at minimum:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET` (any random string)

### 5. Deploy Cloudflare Workers

Reddit blocks requests from cloud IPs (Vercel, AWS). The reddit-proxy worker routes requests through Cloudflare's edge network.

```bash
# Install wrangler if you haven't
npm i -g wrangler
wrangler login

# Deploy the Reddit proxy
cd workers/reddit-proxy
wrangler secret put CRON_SECRET  # paste your CRON_SECRET
wrangler deploy

# Deploy the orchestrator
cd ../signal-orchestrator
wrangler secret put CRON_SECRET
wrangler secret put SIGNAL_RUN_URL  # https://yourdomain.com/api/cron/signal
wrangler deploy
```

Set `REDDIT_PROXY_URL` in your `.env` to the reddit-proxy worker URL.

### 6. Deploy to Vercel

```bash
vercel deploy
```

Or connect the GitHub repo in the Vercel dashboard.

### 7. Trigger first run

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://yourdomain.com/api/cron/signal
```

Your feed should populate within a minute.

## Optional features

### AI scoring

Set `AI_API_KEY` and optionally `AI_MODEL` in your environment. Defaults to Claude Haiku 4.5 (~$1-2/month). Without it, posts are ranked by engagement score alone — still works great.

### Email digest

Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. The weekly digest runs via `/api/cron/signal-digest` — trigger it with a Vercel cron or another Cloudflare Worker.

### Upstash Redis

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for production-grade rate limiting. Falls back to in-memory rate limiting without it.

## Architecture

```
src/
├── signal.config.ts          # YOUR CONFIG — edit this
├── lib/signal/               # Core pipeline
│   ├── config.ts             # Reads from signal.config.ts
│   ├── reddit.ts             # Fetch + source state
│   ├── scoring.ts            # Engagement scoring
│   ├── ai-scorer.ts          # AI classification (optional)
│   ├── diversity.ts          # Diversity reranking
│   ├── publish.ts            # Snapshot publishing
│   ├── archive.ts            # Daily archives
│   ├── runs.ts               # Pipeline tracking
│   └── alerts.ts             # Email alerts
├── app/
│   ├── page.tsx              # Main feed page
│   ├── signal-client.tsx     # Client component
│   ├── [date]/page.tsx       # Archive page
│   ├── feed.xml/route.ts     # RSS feed
│   └── api/
│       ├── signal/           # Feed + boost + subscribe + feedback
│       └── cron/signal/      # Pipeline cron
workers/
├── signal-orchestrator/      # 15-min cron + queue
└── reddit-proxy/             # Reddit IP proxy
supabase/
└── migrations/001_init.sql   # Full database schema
```

## Cost

| Service | Free tier | What it covers |
|---------|-----------|---------------|
| Supabase | 500MB database | All signal data |
| Cloudflare Workers | 100k requests/day | Cron + Reddit proxy |
| Vercel | Hobby plan | Next.js hosting |
| AI scoring (optional) | ~$1-2/month | Claude Haiku 4.5 |

Without AI scoring, the total cost is **$0/month**.

## License

MIT
