# figue-rooms

A shared, time-boxed, disposable-camera-style posting space. Fully separate
app from the main `figue` journal — different folder, different database,
deployed independently. The journal is untouched by any of this.

## How it works

- Only the owner can create a room (`/create`, gated by `ADMIN_KEY`).
- Anyone with the invite link (`/r/<code>`) can join with just a display name
  (remembered in their browser) and post — text, a short video, a drawing, or
  a Spotify link.
- While the room is open, nobody (including the poster) can see any post.
- The moment the room's end time passes, it "develops": every post becomes
  visible to everyone, sorted chronologically. This is computed from the
  clock, not a background job — there's nothing to keep running.
- No edits, no deletes, ever (from participants - see "Backing up a room"
  below for the one admin-only exception).
- Videos are re-encoded server-side (h.264/aac mp4, capped at 1280px wide) on
  upload. This keeps phone footage from eating the free storage quota and,
  just as importantly, makes sure a clip recorded in one browser actually
  plays back in whatever browser someone else opens the archive in later.
  Recording is capped at 90 seconds client-side and 200MB server-side - the
  90s figure is arbitrary and easy to change; the 200MB one is a real ceiling
  (Render's free tier has ~512MB RAM, and the file sits fully in memory
  before compression shrinks it).

## Local dev

```
npm install
cp .env.example .env   # fill in real values
npm start
```

Without real Supabase credentials the server still boots (useful for poking
at the UI), but every `/api/*` call will fail.

## Deploying

See the deployment walkthrough your assistant gave you in chat. Short version:

1. Create a Supabase project, run `supabase/schema.sql` in its SQL Editor,
   grab the Project URL + `service_role` key from Project Settings -> API.
2. Push this folder to its own GitHub repo (it's independent of the figue
   journal's repo/files on purpose).
3. On Render: New -> Blueprint -> pick the repo (it reads `render.yaml` at
   the repo root). Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `ADMIN_KEY` when prompted.
4. Visit `https://<your-service>.onrender.com/create`, enter your `ADMIN_KEY`,
   create a room, and share the invite link it gives you.

Render's free tier sleeps after inactivity and takes ~30-60s to wake back up
on the first request — the room page shows a "waking up" message and retries
automatically, so this is harmless, just slow the first time.

Supabase free projects are a different story: they auto-pause after 7 days
with **no database activity at all**, and won't wake themselves back up on
the next request the way Render does - that needs a manual click in the
Supabase dashboard. `.github/workflows/keep-alive.yml` pings `/api/health`
once a day (via GitHub Actions, also free) specifically to prevent that,
so a quiet room in between get-togethers doesn't quietly stop working.

## Backing up a room (and reclaiming its storage)

Once a room has developed, you can pull everything - every post, every
video, every drawing - down to your own computer:

```
npm run backup -- <invite-code>
```

This writes `backups/<code>-<room-name>/posts.json` plus a `media/` folder
with every file, using the `ADMIN_KEY` and (optionally) `ROOMS_BASE_URL`
from your local `.env`. Nothing on the server is touched.

Once you've confirmed the backup looks right, you can free up that room's
space on Supabase:

```
npm run backup -- <invite-code> --purge
```

This re-downloads (safe to run again), then asks you to type `YES` before
permanently deleting that room and its files from Supabase - your local copy
in `backups/` is unaffected either way. `backups/` is gitignored: it holds
real photos/videos of real people, so it should never end up on GitHub.
