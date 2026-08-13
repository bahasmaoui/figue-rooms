#!/usr/bin/env node
// Downloads a developed room's full contents (text/song posts as JSON, every
// video/drawing as an actual file) to a local folder - then, only if you
// confirm, deletes that room and its media from Supabase to reclaim space.
//
// Usage:
//   node scripts/backup-room.js <invite-code>
//   node scripts/backup-room.js <invite-code> --purge
//
// Reads ADMIN_KEY (and optionally ROOMS_BASE_URL) from rooms-server/.env.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

loadDotEnv();

const code = process.argv[2];
const shouldPurge = process.argv.includes("--purge");

if (!code) {
  console.error("Usage: node scripts/backup-room.js <invite-code> [--purge]");
  process.exit(1);
}

const adminKey = process.env.ADMIN_KEY;
if (!adminKey) {
  console.error("Set ADMIN_KEY in rooms-server/.env first.");
  process.exit(1);
}
const baseUrl = process.env.ROOMS_BASE_URL || "https://figue-rooms.onrender.com";

async function main() {
  console.log(`Fetching "${code}" from ${baseUrl}...`);
  const res = await fetch(`${baseUrl}/api/admin/rooms/${code}/export`, {
    headers: { "x-admin-key": adminKey },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Error:", data.error || res.status);
    process.exit(1);
  }

  const dir = path.join(__dirname, "..", "backups", `${data.inviteCode}-${slugify(data.name)}`);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "posts.json"), JSON.stringify(data, null, 2));

  let downloaded = 0;
  for (const post of data.posts) {
    for (const field of ["videoUrl", "imageUrl"]) {
      const url = post[field];
      if (!url) continue;
      const ext = path.extname(new URL(url).pathname) || "";
      const safeAuthor = post.authorName.replace(/[^a-z0-9]/gi, "_").slice(0, 30);
      const filename = `${post.createdAt.replace(/[:.]/g, "-")}_${safeAuthor}_${post.id.slice(0, 8)}${ext}`;
      await downloadFile(url, path.join(dir, "media", filename));
      downloaded++;
    }
  }

  console.log(`\nSaved ${data.posts.length} posts and ${downloaded} media files to:\n  ${dir}\n`);

  if (!shouldPurge) {
    console.log("Run again with --purge once you've confirmed the backup looks good, to free up Supabase storage.");
    return;
  }

  const confirmed = await confirm(
    `Type YES to permanently delete "${data.name}" (${downloaded} files) from the live server now that it's backed up: `
  );
  if (!confirmed) {
    console.log("Not deleted. Your local backup is still saved above.");
    return;
  }

  const delRes = await fetch(`${baseUrl}/api/admin/rooms/${code}`, {
    method: "DELETE",
    headers: { "x-admin-key": adminKey },
  });
  const delData = await delRes.json();
  if (!delRes.ok) {
    console.error("Delete failed:", delData.error || delRes.status);
    process.exit(1);
  }
  console.log(`Deleted from Supabase: ${delData.deletedPosts} posts, ${delData.deletedFiles} files freed.`);
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "room";
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() === "YES");
    });
  });
}

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = (match[2] || "").trim();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
