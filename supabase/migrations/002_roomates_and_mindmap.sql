-- Run this once in the SQL Editor of your EXISTING Supabase project to add
-- Roomate tagging + the Mindmap view. (schema.sql has also been updated to
-- match, for anyone setting up a brand new project from scratch.)

alter table posts add column if not exists roomate_tags text[] not null default '{}';
alter table posts add column if not exists post_date date;

create table if not exists participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  display_name text not null,
  joined_at timestamptz not null default now(),
  unique (room_id, display_name)
);

create index if not exists participants_room_id_idx on participants (room_id);

alter table participants enable row level security;
