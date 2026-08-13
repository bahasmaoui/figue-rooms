const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
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

const VIDEO_EXT_BY_SUBTYPE = { webm: "webm", mp4: "mp4", ogg: "ogv", quicktime: "mov" };
const IMAGE_EXT_BY_SUBTYPE = { png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp" };
function extFor(mimetype, table, fallback) {
  const subtype = (mimetype || "").split("/")[1]?.split(";")[0];
  return table[subtype] || fallback;
}

async function uploadToBucket(roomId, file, table, fallbackExt) {
  const ext = extFor(file.mimetype, table, fallbackExt);
  const objectPath = `${roomId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(objectPath, file.buffer, { contentType: file.mimetype });
  if (error) throw error;
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectPath).data.publicUrl;
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
        if (videoFile) post.video_url = await uploadToBucket(room.id, videoFile, VIDEO_EXT_BY_SUBTYPE, "webm");
        if (!post.content_text && !post.video_url) {
          return res.status(400).json({ error: "Write something or attach a video." });
        }
      } else if (type === "drawing") {
        const imageFile = req.files?.image?.[0];
        if (!imageFile) return res.status(400).json({ error: "A drawing needs image data." });
        post.image_url = await uploadToBucket(room.id, imageFile, IMAGE_EXT_BY_SUBTYPE, "png");
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

  res.json({
    name: room.name,
    endsAt: room.ends_at,
    posts: posts.map((p) => ({
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
    })),
  });
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
