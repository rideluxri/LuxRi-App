-- Run this once in your Supabase project's SQL Editor (Supabase dashboard > SQL Editor > New query).
-- This creates the single key/value table the app uses for everything:
-- bookings, accounts, ride history, availability hours, and business promos.

create table if not exists kv_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Row Level Security: this app has its own simple account/password system
-- (not Supabase Auth), so it talks to this table using the public anon key.
-- That means anyone with your anon key can read/write this table — fine to
-- launch with, but worth knowing. The honest fix later is to move reads and
-- writes behind a small serverless function so the anon key never touches
-- the database directly. For now, this keeps things working:
alter table kv_store enable row level security;

create policy "Allow anon read" on kv_store
  for select using (true);

create policy "Allow anon write" on kv_store
  for insert with check (true);

create policy "Allow anon update" on kv_store
  for update using (true);

create policy "Allow anon delete" on kv_store
  for delete using (true);
