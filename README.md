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
- No edits, no deletes, ever.

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
