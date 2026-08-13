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

// Express 4 (unlike 5) doesn't catch promise rejections from async route
// handlers on its own, and this app has several - a single unexpected
// throw (a flaky network call, an unusual Supabase response) would
// otherwise become an unhandled rejection, which crashes the whole
// process on modern Node and takes the app down for every other room
// until Render restarts it. This is the last-resort backstop: log it,
// keep serving everyone else. It's not a substitute for the try/catch in
// each handler, just insurance against the ones that get missed.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

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
app.get("/r/:code/mindmap", (req, res) => res.sendFile(path.join(__dirname, "public", "mindmap.html")));
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

// ---------- Joining (public) ----------
// Registers a display name against this room so the "tag a roomate" picker
// and the mindmap have someone to show, independent of whether that person
// has posted anything yet. Names only - never post content - so this is
// fine to expose while the room's still sealed.
app.post("/api/rooms/:code/join", async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });

  const displayName = (req.body.displayName || "").trim().slice(0, 40);
  if (!displayName) return res.status(400).json({ error: "Enter a display name first." });

  const { error } = await supabase
    .from("participants")
    .upsert({ room_id: room.id, display_name: displayName }, { onConflict: "room_id,display_name", ignoreDuplicates: true });
  if (error) return res.status(500).json({ error: "Couldn't join the room." });

  res.status(201).json({ ok: true });
});

app.get("/api/rooms/:code/participants", async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });

  const { data, error } = await supabase
    .from("participants")
    .select("display_name")
    .eq("room_id", room.id)
    .order("joined_at", { ascending: true });
  if (error) return res.status(500).json({ error: "Couldn't load participants." });

  res.json({ names: data.map((p) => p.display_name) });
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
      // x264 sizes its thread pool and lookahead buffers off the host's
      // reported CPU count, not the container's actual (much smaller) share
      // on Render's free tier - left uncapped, that overshoots available
      // memory on a box that reports many more cores than it really grants
      // this container. Pinning both keeps the encoder's footprint small
      // and predictable regardless of what the host claims.
      "-threads", "1",
      "-x264-params", "threads=1:lookahead-threads=1:sliced-threads=0:rc-lookahead=20",
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

// roomateTags arrives as a JSON-encoded array string (one plain form field,
// works the same whether the request is multipart or not). Never trust it
// blindly: cap the count and length of each name, drop empties/dupes, and
// never let someone tag themselves as their own roomate.
function parseRoomateTags(raw, authorName) {
  let names;
  try {
    names = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];

  const seen = new Set();
  const out = [];
  for (const n of names) {
    const name = String(n || "").trim().slice(0, 40);
    if (!name || name === authorName || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

app.post("/api/rooms/:code/posts", (req, res) => {
  // multer invokes this callback directly (not as a chained Express
  // middleware), so Express never gets a chance to catch a rejection from
  // it - an async callback here that throws outside its own try/catch
  // becomes an unhandled promise rejection, which crashes the whole
  // process on modern Node. Everything below must funnel through this one
  // try/catch so that can never happen, no matter which line fails.
  upload(req, res, async (uploadErr) => {
    try {
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

      const post = {
        room_id: room.id,
        author_name: authorName,
        type,
        roomate_tags: parseRoomateTags(req.body.roomateTags, authorName),
      };
      const postDate = (req.body.postDate || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(postDate)) post.post_date = postDate;

      if (type === "note") {
        post.title = (req.body.title || "").trim().slice(0, 120);
        post.content_text = (req.body.contentText || "").trim().slice(0, 4000);
        const videoFile = req.files?.video?.[0];
        if (videoFile) post.video_url = await uploadVideoToBucket(room.id, videoFile);
        // The mobile story flow captures a photo instead of a video - a
        // "note" post can carry either (or neither, if it's text-only).
        const imageFile = req.files?.image?.[0];
        if (imageFile) post.image_url = await uploadImageToBucket(room.id, imageFile);
        if (!post.content_text && !post.video_url && !post.image_url) {
          return res.status(400).json({ error: "Write something, or attach a photo/video." });
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

      const { count: existingCount } = await supabase
        .from("posts")
        .select("id", { count: "exact", head: true })
        .eq("room_id", room.id);

      const { error } = await supabase.from("posts").insert(post);
      if (error) return res.status(500).json({ error: "Couldn't save that post." });

      res.status(201).json({ ok: true, rollCount: (existingCount || 0) + 1 });
    } catch (err) {
      console.error("POST /api/rooms/:code/posts failed:", err);
      res.status(500).json({ error: "Something went wrong saving that post - try again." });
    }
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
    roomateTags: p.roomate_tags || [],
    postDate: p.post_date,
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

// ---------- Mindmap: who's connected to who, via shared Roomate tags ----------
// Available whether the room is open or developed - it only reveals the
// *shape* of connections (names + how many posts link a pair), never post
// content, so it can't spoil the reveal. Post IDs (used to look up the
// actual posts behind a connection) are only included once developed.
app.get("/api/rooms/:code/mindmap", async (req, res) => {
  const room = await getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  const developed = isDeveloped(room);

  const [{ data: participants, error: pErr }, { data: posts, error: postErr }] = await Promise.all([
    supabase.from("participants").select("display_name").eq("room_id", room.id),
    supabase.from("posts").select("id, author_name, roomate_tags").eq("room_id", room.id),
  ]);
  if (pErr || postErr) return res.status(500).json({ error: "Couldn't build the mindmap." });

  const nodeNames = new Set((participants || []).map((p) => p.display_name));
  const nodePosts = new Map(); // name -> Set(postId)
  const edgeMap = new Map(); // "A||B" (sorted) -> { a, b, weight, postIds }

  for (const post of posts || []) {
    const group = Array.from(new Set([post.author_name, ...(post.roomate_tags || [])].filter(Boolean)));
    for (const name of group) {
      nodeNames.add(name);
      if (!nodePosts.has(name)) nodePosts.set(name, new Set());
      nodePosts.get(name).add(post.id);
    }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]].sort();
        const key = `${a}||${b}`;
        if (!edgeMap.has(key)) edgeMap.set(key, { a, b, weight: 0, postIds: [] });
        const edge = edgeMap.get(key);
        edge.weight += 1;
        edge.postIds.push(post.id);
      }
    }
  }

  const nodes = Array.from(nodeNames).map((name) => ({
    name,
    postCount: nodePosts.get(name)?.size || 0,
    postIds: developed ? Array.from(nodePosts.get(name) || []) : undefined,
  }));
  const edges = Array.from(edgeMap.values()).map((e) => ({
    a: e.a,
    b: e.b,
    weight: e.weight,
    postIds: developed ? e.postIds : undefined,
  }));

  res.json({ name: room.name, developed, nodes, edges });
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
