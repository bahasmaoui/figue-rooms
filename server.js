const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 4300;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MEDIA_BUCKET = "room-media";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set - the server will boot " +
    "(so you can sanity-check it locally) but every /api/* call will fail until they're set."
  );
}
if (!ADMIN_KEY) {
  console.warn("ADMIN_KEY is not set - room creation is unprotected until you set it.");
}

const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder"
);

// Best-effort: create the storage bucket for video/drawing uploads on boot,
// so there's one less manual step in Supabase's dashboard. Safe to ignore
// failures here (bucket already exists, or creds aren't set up yet).
supabase.storage.createBucket(MEDIA_BUCKET, { public: true }).catch(() => {});

const app = express();
// Render (and most PaaS hosts) terminate TLS at the edge and proxy to the
// app over plain HTTP - without this, req.protocol always reads "http",
// which would hand out "http://" invite links. Camera access for the video
// attachment requires a secure context, so a wrong scheme here silently
// breaks recording for everyone except localhost.
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

// ---------- Invite codes ----------
// Friendly alphabet: no 0/O or 1/I/L mixups when someone reads a code aloud
// or types it in by hand instead of clicking the link.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateInviteCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Not authorized" });
  }
  next();
}

function isDeveloped(room) {
  return new Date() >= new Date(room.ends_at);
}

// ---------- Page routes (must precede express.static so /r/:code isn't 404'd as a missing directory) ----------
app.get("/create", (req, res) => res.sendFile(path.join(__dirname, "public", "create.html")));
app.get("/r/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "room.html")));

app.use(express.static(path.join(__dirname, "public")));

// ---------- Create a room (owner only) ----------
app.post("/api/rooms", requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim().slice(0, 80);
  const endsAt = new Date(req.body.endsAt);
  if (!name) return res.status(400).json({ error: "Give the room a name." });
  if (Number.isNaN(endsAt.getTime()) || endsAt <= new Date()) {
    return res.status(400).json({ error: "Pick an end date/time in the future." });
  }

  const inviteCode = generateInviteCode();
  const { data, error } = await supabase
    .from("rooms")
    .insert({ name, invite_code: inviteCode, ends_at: endsAt.toISOString() })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Couldn't create the room." });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.status(201).json({
    id: data.id,
    name: data.name,
    inviteCode: data.invite_code,
    endsAt: data.ends_at,
    joinUrl: `${baseUrl}/r/${data.invite_code}`,
  });
});

// ---------- Room status (public) ----------
app.get("/api/rooms/:code", async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });

  const { count } = await supabase
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("room_id", room.id);

  res.json({
    name: room.name,
    endsAt: room.ends_at,
    developed: isDeveloped(room),
    postCount: count || 0,
  });
});

// ---------- Post into a room (public, blind) ----------
// 200MB bounds worst-case memory use (the file sits fully in RAM - see
// compressVideo below - before compression shrinks it, and Render's free
// tier has ~512MB total), not storage: raw browser recordings capped at
// ROOM_MAX_RECORD_MS (see public/room.js) come in far under this.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
}).fields([
  { name: "video", maxCount: 1 },
  { name: "image", maxCount: 1 },
]);

const SPOTIFY_RE =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/i;
function toEmbedUrl(spotifyUrl) {
  const match = SPOTIFY_RE.exec((spotifyUrl || "").trim());
  if (!match) return null;
  const [, kind, id] = match;
  return `https://open.spotify.com/embed/${kind}/${id}`;
}

const IMAGE_EXT_BY_SUBTYPE = { png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp" };
function extFor(mimetype, table, fallback) {
  const subtype = (mimetype || "").split("/")[1]?.split(";")[0];
  return table[subtype] || fallback;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 55000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(-500) || err.message));
      resolve();
    });
  });
}

// Re-encodes to a modest, consistent H.264/AAC mp4 - shrinks phone-camera
// footage considerably (helps the free Supabase storage quota go further)
// and, just as importantly, normalizes format: without this, a video
// recorded in Safari might not play back in whatever browser someone
// else opens the archive in later.
async function compressVideo(buffer) {
  const inPath = path.join(os.tmpdir(), `${crypto.randomUUID()}-in`);
  const outPath = path.join(os.tmpdir(), `${crypto.randomUUID()}-out.mp4`);
  await fs.writeFile(inPath, buffer);
  try {
    await runFfmpeg([
      "-y",
      "-i", inPath,
      "-vf", "scale='min(1280,iw)':-2",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "27",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      outPath,
    ]);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(inPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}

async function uploadVideoToBucket(roomId, file) {
  let buffer = file.buffer;
  let contentType = "video/mp4";
  let ext = "mp4";
  try {
    buffer = await compressVideo(file.buffer);
  } catch (err) {
    console.error("video compression failed, uploading original instead:", err.message);
    contentType = file.mimetype;
    ext = extFor(file.mimetype, { webm: "webm", mp4: "mp4", ogg: "ogv", quicktime: "mov" }, "webm");
  }
  const objectPath = `${roomId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(objectPath, buffer, { contentType });
  if (error) throw error;
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectPath).data.publicUrl;
}

async function uploadImageToBucket(roomId, file) {
  const ext = extFor(file.mimetype, IMAGE_EXT_BY_SUBTYPE, "png");
  const objectPath = `${roomId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(objectPath, file.buffer, { contentType: file.mimetype });
  if (error) throw error;
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectPath).data.publicUrl;
}

// Supabase public URLs look like ".../storage/v1/object/public/<bucket>/<path>" -
// pull <path> back out so admin room-deletion can also clean up the files.
function storagePathFromUrl(url) {
  if (!url) return null;
  const marker = `/object/public/${MEDIA_BUCKET}/`;
  const idx = url.indexOf(marker);
  return idx === -1 ? null : decodeURIComponent(url.slice(idx + marker.length));
}

app.post("/api/rooms/:code/posts", (req, res) => {
  upload(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: "That file was too big or unreadable." });

    const room = await getRoomByCode(req.params.code);
    if (!room) return res.status(404).json({ error: "Room not found." });
    if (isDeveloped(room)) {
      return res.status(403).json({ error: "This roll has already developed - it's not accepting new posts." });
    }

    const authorName = (req.body.authorName || "").trim().slice(0, 40);
    const type = req.body.type;
    if (!authorName) return res.status(400).json({ error: "Enter a display name first." });
    if (!["note", "drawing", "song"].includes(type)) {
      return res.status(400).json({ error: "Unknown post type." });
    }

    const post = { room_id: room.id, author_name: authorName, type };

    try {
      if (type === "note") {
        post.title = (req.body.title || "").trim().slice(0, 120);
        post.content_text = (req.body.contentText || "").trim().slice(0, 4000);
        const videoFile = req.files?.video?.[0];
        if (videoFile) post.video_url = await uploadVideoToBucket(room.id, videoFile);
        if (!post.content_text && !post.video_url) {
          return res.status(400).json({ error: "Write something or attach a video." });
        }
      } else if (type === "drawing") {
        const imageFile = req.files?.image?.[0];
        if (!imageFile) return res.status(400).json({ error: "A drawing needs image data." });
        post.image_url = await uploadImageToBucket(room.id, imageFile);
        post.caption = (req.body.caption || "").trim().slice(0, 160);
      } else if (type === "song") {
        const embedUrl = toEmbedUrl(req.body.spotifyUrl);
        if (!embedUrl) return res.status(400).json({ error: "Paste a valid open.spotify.com link." });
        post.spotify_url = req.body.spotifyUrl.trim();
        post.embed_url = embedUrl;
        post.caption = (req.body.caption || "").trim().slice(0, 160);
        post.lyric = (req.body.lyric || "").trim().slice(0, 240);
      }
    } catch {
      return res.status(500).json({ error: "Couldn't store that file - try again." });
    }

    const { count: existingCount } = await supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("room_id", room.id);

    const { error } = await supabase.from("posts").insert(post);
    if (error) return res.status(500).json({ error: "Couldn't save that post." });

    res.status(201).json({ ok: true, rollCount: (existingCount || 0) + 1 });
  });
});

// ---------- Archive: only once developed ----------
app.get("/api/rooms/:code/archive", async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (!isDeveloped(room)) {
    return res.status(403).json({ error: "This roll hasn't developed yet.", endsAt: room.ends_at });
  }

  const { data: posts, error } = await supabase
    .from("posts")
    .select("*")
    .eq("room_id", room.id)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: "Couldn't load the archive." });

  res.json({ name: room.name, endsAt: room.ends_at, posts: posts.map(mapPost) });
});

function mapPost(p) {
  return {
    id: p.id,
    authorName: p.author_name,
    type: p.type,
    title: p.title,
    contentText: p.content_text,
    videoUrl: p.video_url,
    imageUrl: p.image_url,
    caption: p.caption,
    spotifyUrl: p.spotify_url,
    embedUrl: p.embed_url,
    lyric: p.lyric,
    createdAt: p.created_at,
  };
}

// ---------- Admin: back up a developed room, then optionally reclaim its storage ----------
app.get("/api/admin/rooms/:code/export", requireAdmin, async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (!isDeveloped(room)) return res.status(403).json({ error: "This roll hasn't developed yet." });

  const { data: posts, error } = await supabase
    .from("posts")
    .select("*")
    .eq("room_id", room.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load posts." });

  res.json({
    name: room.name,
    inviteCode: room.invite_code,
    createdAt: room.created_at,
    endsAt: room.ends_at,
    posts: posts.map(mapPost),
  });
});

app.delete("/api/admin/rooms/:code", requireAdmin, async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (!isDeveloped(room)) {
    return res.status(403).json({ error: "This roll hasn't developed yet - back it up after it develops." });
  }

  const { data: posts } = await supabase.from("posts").select("video_url, image_url").eq("room_id", room.id);
  const paths = (posts || []).flatMap((p) => [storagePathFromUrl(p.video_url), storagePathFromUrl(p.image_url)]).filter(Boolean);
  if (paths.length) await supabase.storage.from(MEDIA_BUCKET).remove(paths);

  const { error } = await supabase.from("rooms").delete().eq("id", room.id);
  if (error) return res.status(500).json({ error: "Couldn't delete the room." });

  res.json({ ok: true, deletedPosts: (posts || []).length, deletedFiles: paths.length });
});

// Supabase free projects auto-pause after 7 days with no database activity,
// and (unlike Render's own sleep) won't wake themselves back up on the next
// request - a manual dashboard click is required. A scheduled ping at this
// endpoint (see .github/workflows/keep-alive.yml) touches the database just
// enough to reset that clock, for free, so a quiet room doesn't quietly break.
app.get("/api/health", async (req, res) => {
  const { error } = await supabase.from("rooms").select("id", { head: true, count: "exact" });
  res.status(error ? 500 : 200).json({ ok: !error, time: new Date().toISOString() });
});

async function getRoomByCode(code) {
  const { data } = await supabase
    .from("rooms")
    .select("*")
    .eq("invite_code", (code || "").toUpperCase())
    .maybeSingle();
  return data || null;
}

app.listen(PORT, () => {
  console.log(`figue-rooms running on port ${PORT}`);
});
