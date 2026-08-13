(() => {
  "use strict";

  const NAME_KEY = "figue-rooms-name";
  const MAX_RECORD_MS = 90000;
  const CODE = location.pathname.split("/").filter(Boolean).pop();

  const els = {
    roomTitle: document.getElementById("room-title"),
    loadingCard: document.getElementById("loading-card"),
    loadingText: document.getElementById("loading-text"),
    notfoundCard: document.getElementById("notfound-card"),
    nameCard: document.getElementById("name-card"),
    nameRoomTitle: document.getElementById("name-room-title"),
    nameInput: document.getElementById("name-input"),
    nameSubmit: document.getElementById("name-submit"),
    nameError: document.getElementById("name-error"),
    composerCard: document.getElementById("composer-card"),
    composerRoomTitle: document.getElementById("composer-room-title"),
    composerHint: document.getElementById("composer-hint"),
    composerError: document.getElementById("composer-error"),
    postSubmit: document.getElementById("post-submit"),
    confirmCard: document.getElementById("confirm-card"),
    confirmText: document.getElementById("confirm-text"),
    postAnother: document.getElementById("post-another"),
    developedHeaderCard: document.getElementById("developed-header-card"),
    archiveTitle: document.getElementById("archive-title"),
    archiveCount: document.getElementById("archive-count"),
    archiveList: document.getElementById("archive-list"),

    noteText: document.getElementById("note-text"),
    recordBtn: document.getElementById("record-btn"),
    stopBtn: document.getElementById("stop-btn"),
    recTimer: document.getElementById("rec-timer"),
    camPreview: document.getElementById("cam-preview"),
    reviewPreview: document.getElementById("review-preview"),
    discardVideoBtn: document.getElementById("discard-video-btn"),

    swatches: document.getElementById("swatches"),
    clearCanvasBtn: document.getElementById("clear-canvas-btn"),
    drawCanvas: document.getElementById("draw-canvas"),
    drawingCaption: document.getElementById("drawing-caption"),

    songUrl: document.getElementById("song-url"),
    songCaption: document.getElementById("song-caption"),
    songLyric: document.getElementById("song-lyric"),
  };

  let room = null;
  let currentMode = "note";
  let pendingVideoBlob = null;
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recStartedAt = 0;
  let recTimerInterval = null;
  let statusPollInterval = null;

  function show(card) {
    [els.loadingCard, els.notfoundCard, els.nameCard, els.composerCard, els.confirmCard].forEach((c) =>
      c.classList.add("hidden")
    );
    card.classList.remove("hidden");
  }

  // ---------- Boot: fetch room status, retrying through Render's free-tier cold start ----------
  async function boot() {
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const res = await fetch(`/api/rooms/${CODE}`, { cache: "no-store" });
        if (res.status === 404) return show(els.notfoundCard);
        if (!res.ok) throw new Error("bad status");
        room = await res.json();
        break;
      } catch {
        els.loadingText.textContent =
          attempt < 3
            ? "Waking up the room… this can take up to a minute if it's been quiet for a while."
            : `Still waking up… (attempt ${attempt})`;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    onRoomLoaded();
  }

  function onRoomLoaded() {
    document.title = `rooms. — ${room.name}`;
    els.roomTitle.innerHTML = `📷 ${escapeHtml(room.name)}<span class="dot">.</span>`;

    if (room.developed) return renderArchive();

    els.nameRoomTitle.textContent = `Join "${room.name}"`;
    els.composerRoomTitle.textContent = room.name;
    updateComposerHint();

    const savedName = localStorage.getItem(NAME_KEY);
    if (savedName) {
      show(els.composerCard);
    } else {
      show(els.nameCard);
    }

    if (statusPollInterval) clearInterval(statusPollInterval);
    statusPollInterval = setInterval(checkIfDeveloped, 30000);
  }

  async function checkIfDeveloped() {
    try {
      const res = await fetch(`/api/rooms/${CODE}`, { cache: "no-store" });
      if (!res.ok) return;
      const fresh = await res.json();
      room = fresh;
      if (room.developed) {
        clearInterval(statusPollInterval);
        renderArchive();
      } else {
        updateComposerHint();
      }
    } catch {
      // transient - the next poll will retry
    }
  }

  function updateComposerHint() {
    const endsAt = new Date(room.endsAt);
    els.composerHint.textContent =
      `Develops ${endsAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} — ` +
      `you won't see what's been added until then. ${room.postCount} shot${room.postCount === 1 ? "" : "s"} on the roll so far.`;
  }

  // ---------- Name gate ----------
  els.nameSubmit.addEventListener("click", () => {
    const name = els.nameInput.value.trim();
    if (!name) return (els.nameError.textContent = "Enter a name first.");
    localStorage.setItem(NAME_KEY, name);
    show(els.composerCard);
  });
  els.nameInput.addEventListener("keydown", (e) => e.key === "Enter" && els.nameSubmit.click());

  // ---------- Composer tabs ----------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentMode = btn.dataset.mode;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".composer-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== currentMode));
      if (currentMode === "drawing") initCanvasOnce();
      els.composerError.textContent = "";
    });
  });

  // ---------- Video recording ----------
  els.recordBtn.addEventListener("click", async () => {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      return (els.composerError.textContent = "Couldn't access your camera.");
    }
    els.camPreview.srcObject = mediaStream;
    els.camPreview.classList.remove("hidden");
    els.reviewPreview.classList.add("hidden");
    els.discardVideoBtn.classList.add("hidden");
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => e.data.size && recordedChunks.push(e.data);
    mediaRecorder.onstop = onRecordingStopped;
    mediaRecorder.start();
    recStartedAt = Date.now();
    els.recordBtn.classList.add("hidden");
    els.stopBtn.classList.remove("hidden");
    recTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - recStartedAt) / 1000);
      els.recTimer.textContent = `● ${secs}s`;
      if (Date.now() - recStartedAt >= MAX_RECORD_MS) stopRecording();
    }, 250);
  });

  els.stopBtn.addEventListener("click", stopRecording);

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }

  function onRecordingStopped() {
    clearInterval(recTimerInterval);
    els.recTimer.textContent = "";
    els.recordBtn.classList.remove("hidden");
    els.stopBtn.classList.add("hidden");
    els.camPreview.classList.add("hidden");
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());

    // Safari's MediaRecorder actually encodes mp4, not webm - trust its own
    // reported mimeType instead of assuming, so the upload's declared
    // Content-Type matches what's really in the file.
    pendingVideoBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" });
    els.reviewPreview.src = URL.createObjectURL(pendingVideoBlob);
    els.reviewPreview.classList.remove("hidden");
    els.discardVideoBtn.classList.remove("hidden");
  }

  els.discardVideoBtn.addEventListener("click", () => {
    pendingVideoBlob = null;
    els.reviewPreview.classList.add("hidden");
    els.discardVideoBtn.classList.add("hidden");
  });

  // ---------- Drawing ----------
  const DRAW_COLORS = ["#1a1a1a", "#e05252", "#e8a33d", "#4caf7d", "#4a90e2", "#ffffff"];
  let drawCtx = null;
  let currentColor = DRAW_COLORS[0];
  let isDrawing = false;
  let hasDrawn = false;
  let canvasReady = false;

  function initCanvasOnce() {
    if (canvasReady) return;
    canvasReady = true;
    drawCtx = els.drawCanvas.getContext("2d");
    drawCtx.fillStyle = "#ffffff";
    drawCtx.fillRect(0, 0, els.drawCanvas.width, els.drawCanvas.height);
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawCtx.lineWidth = 6;

    DRAW_COLORS.forEach((color, i) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch" + (i === 0 ? " selected" : "");
      sw.style.background = color;
      sw.addEventListener("click", () => {
        currentColor = color;
        document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
        sw.classList.add("selected");
      });
      els.swatches.appendChild(sw);
    });

    const pos = (e) => {
      const rect = els.drawCanvas.getBoundingClientRect();
      const scaleX = els.drawCanvas.width / rect.width;
      const scaleY = els.drawCanvas.height / rect.height;
      return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
    };
    els.drawCanvas.addEventListener("pointerdown", (e) => {
      isDrawing = true;
      hasDrawn = true;
      const p = pos(e);
      drawCtx.strokeStyle = currentColor;
      drawCtx.beginPath();
      drawCtx.moveTo(p.x, p.y);
    });
    els.drawCanvas.addEventListener("pointermove", (e) => {
      if (!isDrawing) return;
      const p = pos(e);
      drawCtx.lineTo(p.x, p.y);
      drawCtx.stroke();
    });
    window.addEventListener("pointerup", () => (isDrawing = false));

    els.clearCanvasBtn.addEventListener("click", () => {
      drawCtx.fillStyle = "#ffffff";
      drawCtx.fillRect(0, 0, els.drawCanvas.width, els.drawCanvas.height);
      hasDrawn = false;
    });
  }

  // ---------- Submit ----------
  els.postSubmit.addEventListener("click", async () => {
    els.composerError.textContent = "";
    const authorName = localStorage.getItem(NAME_KEY) || "";
    const form = new FormData();
    form.append("authorName", authorName);
    form.append("type", currentMode);

    if (currentMode === "note") {
      const text = els.noteText.value.trim();
      if (!text && !pendingVideoBlob) return (els.composerError.textContent = "Write something or attach a video.");
      form.append("contentText", text);
      if (pendingVideoBlob) form.append("video", pendingVideoBlob, "clip.webm");
    } else if (currentMode === "drawing") {
      if (!hasDrawn) return (els.composerError.textContent = "Draw something first.");
      const blob = await new Promise((resolve) => els.drawCanvas.toBlob(resolve, "image/png"));
      form.append("image", blob, "drawing.png");
      form.append("caption", els.drawingCaption.value.trim());
    } else if (currentMode === "song") {
      const url = els.songUrl.value.trim();
      if (!/^https?:\/\/open\.spotify\.com\//i.test(url)) {
        return (els.composerError.textContent = "Paste a valid open.spotify.com link.");
      }
      form.append("spotifyUrl", url);
      form.append("caption", els.songCaption.value.trim());
      form.append("lyric", els.songLyric.value.trim());
    }

    els.postSubmit.disabled = true;
    els.postSubmit.textContent = "Adding…";
    try {
      const res = await fetch(`/api/rooms/${CODE}/posts`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      resetComposer();
      els.confirmText.textContent = `${data.rollCount} shot${data.rollCount === 1 ? "" : "s"} on the roll now. ` +
        `Nobody — including you — can see any of it until "${room.name}" develops.`;
      room.postCount = data.rollCount;
      show(els.confirmCard);
    } catch (err) {
      els.composerError.textContent = err.message || "Couldn't reach the server.";
    } finally {
      els.postSubmit.disabled = false;
      els.postSubmit.textContent = "Add to the roll";
    }
  });

  els.postAnother.addEventListener("click", () => {
    updateComposerHint();
    show(els.composerCard);
  });

  function resetComposer() {
    els.noteText.value = "";
    pendingVideoBlob = null;
    els.reviewPreview.classList.add("hidden");
    els.discardVideoBtn.classList.add("hidden");
    els.drawingCaption.value = "";
    els.songUrl.value = "";
    els.songCaption.value = "";
    els.songLyric.value = "";
    if (drawCtx) {
      drawCtx.fillStyle = "#ffffff";
      drawCtx.fillRect(0, 0, els.drawCanvas.width, els.drawCanvas.height);
      hasDrawn = false;
    }
  }

  // ---------- Archive ----------
  async function renderArchive() {
    show(els.loadingCard);
    els.loadingText.textContent = "Loading the roll…";
    try {
      const res = await fetch(`/api/rooms/${CODE}/archive`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load this room.");

      els.loadingCard.classList.add("hidden");
      els.developedHeaderCard.classList.remove("hidden");
      els.archiveTitle.textContent = room.name;
      els.archiveCount.textContent = `${data.posts.length} shot${data.posts.length === 1 ? "" : "s"} developed`;
      els.archiveList.innerHTML = data.posts.map(renderPostCard).join("");
    } catch (err) {
      els.loadingText.textContent = err.message || "Couldn't load this room.";
    }
  }

  function renderPostCard(p) {
    const when = new Date(p.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    let body = "";
    if (p.type === "note") {
      body = p.contentText ? `<p class="post-text">${escapeHtml(p.contentText)}</p>` : "";
      if (p.videoUrl) body += `<video src="${p.videoUrl}" controls playsinline></video>`;
    } else if (p.type === "drawing") {
      body = `<img src="${p.imageUrl}" alt="drawing" />`;
      if (p.caption) body += `<p class="post-text">${escapeHtml(p.caption)}</p>`;
    } else if (p.type === "song") {
      body = `<iframe src="${p.embedUrl}" height="152" allow="encrypted-media" loading="lazy"></iframe>`;
      if (p.caption) body += `<p class="post-text">${escapeHtml(p.caption)}</p>`;
      if (p.lyric) body += `<p class="post-lyric">"${escapeHtml(p.lyric)}"</p>`;
    }
    return `
      <div class="post-card">
        <div class="post-meta"><span class="post-author">${escapeHtml(p.authorName)}</span><span>${when}</span></div>
        ${body}
      </div>`;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  boot();
})();
