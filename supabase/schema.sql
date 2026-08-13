-- Figue Rooms schema.
-- Run this once in your Supabase project's SQL Editor (SQL Editor -> New query -> paste -> Run).
-- Safe to re-run: uses "if not exists" / "or replace" where possible.

create extension if not exists pgcrypto;

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_at timestamptz not null default now(),
  ends_at timestamptz not null
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  author_name text not null,
  type text not null check (type in ('note', 'drawing', 'song')),
  title text,
  content_text text,
  video_url text,
  image_url text,
  caption text,
  spotify_url text,
  embed_url text,
  lyric text,
  created_at timestamptz not null default now()
);

create index if not exists posts_room_id_idx on posts (room_id);
create index if not exists rooms_invite_code_idx on rooms (invite_code);

-- Lock every table down at the database level. The backend talks to Supabase
-- using the service role key, which bypasses RLS entirely - so with RLS on
-- and zero policies, these tables are completely unreachable by anyone who
-- only has the public anon key (which this app never even hands out, but
-- this is a free, no-downside second lock on the door).
alter table rooms enable row level security;
alter table posts enable row level security;
