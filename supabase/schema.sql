-- Fracture leaderboard schema.
-- Apply via the Supabase SQL editor on a fresh project. No CLI/migration
-- tooling is used for a project this size -- this file is the source of
-- truth to re-run by hand if the project is ever recreated.

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 20),
  score int not null check (score >= 0 and score < 100000),
  created_at timestamptz not null default now()
);

alter table scores enable row level security;

-- Anyone can read the leaderboard.
create policy "scores are publicly readable"
  on scores for select
  to anon
  using (true);

-- Anyone can submit a score, but only name/score (id/created_at are
-- server-controlled defaults) and only within the sanity-checked range
-- enforced by the table constraints above.
create policy "anyone can submit a score"
  on scores for insert
  to anon
  with check (true);

-- No update/delete policies for anon -- scores are append-only once submitted.
