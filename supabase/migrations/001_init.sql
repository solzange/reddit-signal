-- reddit-signal: full database schema
-- Run this in your Supabase SQL editor or via supabase db push

-- ============================================================================
-- signal_posts: main posts table
-- ============================================================================

create table signal_posts (
  id uuid primary key default gen_random_uuid(),
  reddit_post_id text unique not null,
  subreddit text not null,
  title text not null,
  body_snippet text,
  author text not null,
  permalink text not null,
  upvotes integer not null default 0,
  comment_count integer not null default 0,
  upvote_ratio real not null default 0,
  engagement_score real not null default 0,
  ai_quality text not null default 'MEDIUM' check (ai_quality in ('EXEMPLARY', 'HIGH', 'MEDIUM', 'LOW')),
  ai_category text check (ai_category in ('TUTORIAL', 'TOOL', 'INSIGHT', 'SHOWCASE', 'DISCUSSION', 'META')),
  ai_summary text,
  ai_reasoning text,
  self_promo_risk text not null default 'LOW' check (self_promo_risk in ('HIGH', 'MEDIUM', 'LOW')),
  boost_count integer not null default 0,
  display_score real not null default 0,
  posted_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  scored_at timestamptz,
  is_available boolean not null default true,
  availability_checked_at timestamptz,
  unavailable_reason text
);

create index idx_signal_posts_display on signal_posts (display_score desc)
  where ai_quality != 'LOW';

create index idx_signal_posts_category on signal_posts (ai_category, display_score desc)
  where ai_quality != 'LOW';

create index idx_signal_posts_posted_at on signal_posts (posted_at desc);

create index idx_signal_posts_available_posted_at
  on signal_posts (posted_at desc)
  where ai_quality != 'LOW' and is_available = true;

alter table signal_posts enable row level security;

create policy "Signal posts are publicly readable"
  on signal_posts for select using (true);

create policy "Signal posts are not publicly writable"
  on signal_posts for insert with check (false);

create policy "Signal posts are not publicly updatable"
  on signal_posts for update using (false);

create policy "Signal posts are not publicly deletable"
  on signal_posts for delete using (false);

-- ============================================================================
-- signal_boosts: anonymous per-post upvote system
-- ============================================================================

create table signal_boosts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references signal_posts(id) on delete cascade,
  ip_hash text not null,
  created_at timestamptz default now()
);

create unique index idx_signal_boosts_unique on signal_boosts(post_id, ip_hash);
create index idx_signal_boosts_post_id on signal_boosts(post_id);

create or replace function boost_post(p_post_id uuid, p_ip_hash text)
returns boolean as $$
declare
  already_exists boolean;
begin
  select exists(select 1 from signal_boosts where post_id = p_post_id and ip_hash = p_ip_hash) into already_exists;
  if already_exists then
    return false;
  end if;
  insert into signal_boosts (post_id, ip_hash) values (p_post_id, p_ip_hash);
  update signal_posts set boost_count = boost_count + 1 where id = p_post_id;
  return true;
end;
$$ language plpgsql;

alter table signal_boosts enable row level security;

create policy "Anyone can boost"
  on signal_boosts for insert with check (true);

create policy "Boosts are not publicly readable"
  on signal_boosts for select using (false);

-- ============================================================================
-- signal_feedback: anonymous suggestions
-- ============================================================================

create table signal_feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  created_at timestamptz not null default now()
);

alter table signal_feedback enable row level security;

create policy "Signal feedback is insert-only for everyone"
  on signal_feedback for insert with check (true);

create policy "Signal feedback is not publicly readable"
  on signal_feedback for select using (false);

-- ============================================================================
-- signal_subscribers: newsletter
-- ============================================================================

create table signal_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  subscribed_at timestamptz default now(),
  unsubscribed_at timestamptz,
  confirmation_token uuid default gen_random_uuid(),
  confirmed boolean default false
);

create index idx_signal_subs_active on signal_subscribers(confirmed)
  where confirmed = true and unsubscribed_at is null;

alter table signal_subscribers enable row level security;

-- ============================================================================
-- signal_source_state: fetch resilience (cache, cooldown, failure tracking)
-- ============================================================================

create table signal_source_state (
  source_key text primary key,
  kind text not null check (kind in ('subreddit', 'keyword')),
  source_value text not null,
  last_success_payload jsonb,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_status text,
  consecutive_failures integer not null default 0,
  cooldown_until timestamptz
);

alter table signal_source_state enable row level security;

create policy "Signal source state is not publicly readable"
  on signal_source_state for select using (false);

create policy "Signal source state is not publicly writable"
  on signal_source_state for insert with check (false);

create policy "Signal source state is not publicly updatable"
  on signal_source_state for update using (false);

create policy "Signal source state is not publicly deletable"
  on signal_source_state for delete using (false);

-- ============================================================================
-- signal_daily_archives: daily snapshots
-- ============================================================================

create table signal_daily_archives (
  archive_date date primary key,
  posts jsonb not null default '[]'::jsonb,
  post_count integer not null default 0,
  source_last_refresh timestamptz,
  generated_at timestamptz not null default now()
);

create index idx_signal_daily_archives_generated_at
  on signal_daily_archives (generated_at desc);

alter table signal_daily_archives enable row level security;

create policy "Signal daily archives are publicly readable"
  on signal_daily_archives for select using (true);

create policy "Signal daily archives are not publicly writable"
  on signal_daily_archives for insert with check (false);

create policy "Signal daily archives are not publicly updatable"
  on signal_daily_archives for update using (false);

create policy "Signal daily archives are not publicly deletable"
  on signal_daily_archives for delete using (false);

-- ============================================================================
-- signal_current_snapshot: the live feed
-- ============================================================================

create table signal_current_snapshot (
  snapshot_key text primary key,
  posts jsonb not null default '[]'::jsonb,
  post_count integer not null default 0,
  source_last_refresh timestamptz,
  published_at timestamptz not null default now(),
  window_hours integer not null default 24,
  build_meta jsonb
);

create index idx_signal_current_snapshot_published_at
  on signal_current_snapshot (published_at desc);

alter table signal_current_snapshot enable row level security;

create policy "Signal current snapshot is publicly readable"
  on signal_current_snapshot for select using (true);

create policy "Signal current snapshot is not publicly writable"
  on signal_current_snapshot for insert with check (false);

create policy "Signal current snapshot is not publicly updatable"
  on signal_current_snapshot for update using (false);

create policy "Signal current snapshot is not publicly deletable"
  on signal_current_snapshot for delete using (false);

-- ============================================================================
-- signal_pipeline_runs: observability
-- ============================================================================

create table signal_pipeline_runs (
  id bigint generated by default as identity primary key,
  trigger_source text not null,
  status text not null check (status in ('running', 'success', 'warning', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0,
  filtered_count integer not null default 0,
  upserted_count integer not null default 0,
  updated_count integer not null default 0,
  snapshot_post_count integer not null default 0,
  source_stats jsonb,
  result_meta jsonb,
  error_text text
);

create index idx_signal_pipeline_runs_started_at
  on signal_pipeline_runs (started_at desc);

alter table signal_pipeline_runs enable row level security;

create policy "Signal pipeline runs are not publicly readable"
  on signal_pipeline_runs for select using (false);

create policy "Signal pipeline runs are not publicly writable"
  on signal_pipeline_runs for insert with check (false);

create policy "Signal pipeline runs are not publicly updatable"
  on signal_pipeline_runs for update using (false);

create policy "Signal pipeline runs are not publicly deletable"
  on signal_pipeline_runs for delete using (false);
