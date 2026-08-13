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
    mindmapLink: document.getElementById("mindmap-link"),

    composerCard: document.getElementById("composer-card"),
    composerRoomTitle: document.getElementById("composer-room-title"),
    composerHint: document.getElementById("composer-hint"),
    composerError: document.getElementById("composer-error"),
    composerNext: document.getElementById("composer-next"),
    mobileComposerCard: document.getElementById("mobile-composer-card"),
    mobileComposerHint: document.getElementById("mobile-composer-hint"),

    roomateStepCard: document.getElementById("roomate-step-card"),
    roomateList: document.getElementById("roomate-list"),
    roomateEmptyHint: document.getElementById("roomate-empty-hint"),
    roomatePostSubmit: document.getElementById("roomate-post-submit"),
    roomateBack: document.getElementById("roomate-back"),
    roomateError: document.getElementById("roomate-error"),

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

    // mobile story flow
    storyFlow: document.getElementById("story-flow"),
    storyCamera: document.getElementById("story-camera"),
    storyPhotoPreview: document.getElementById("story-photo-preview"),
    storyVideoPreview: document.getElementById("story-video-preview"),
    storyClose: document.getElementById("story-close"),
    storyFlipCamera: document.getElementById("story-flip-camera"),
    storyRecTimer: document.getElementById("story-rec-timer"),
    storyCameraError: document.getElementById("story-camera-error"),
    storyShutter: document.getElementById("story-shutter"),
    storyReviewActions: document.getElementById("story-review-actions"),
    storyRetake: document.getElementById("story-retake"),
    storyNext: document.getElementById("story-next"),
    storyBackToCapture: document.getElementById("story-back-to-capture"),
    storyNextToRoomates: document.getElementById("story-next-to-roomates"),
    storyTitle: document.getElementById("story-title"),
    storyDesc: document.getElementById("story-desc"),
    storyDate: document.getElementById("story-date"),
    storyDetailsError: document.getElementById("story-details-error"),
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

  // Roomate tagging - shared between the desktop composer and the mobile
  // story flow. Whichever flow gets here first stashes the post it's about
  // to submit (as a fully-built FormData) plus where "back" should return
  // to, then the roomate step itself is one implementation either way.
  let pendingForm = null;
  let pendingBackTarget = null;
  const selectedRoomates = new Set();

  function authorName() {
    return localStorage.getItem(NAME_KEY) || "";
  }

  function hideAllWrapCards() {
    [els.loadingCard, els.notfoundCard, els.nameCard, els.composerCard, els.mobileComposerCard, els.roomateStepCard, els.confirmCard]
      .filter(Boolean)
      .forEach((c) => c.classList.add("hidden"));
  }

  function show(card) {
    closeStoryOverlay();
    hideAllWrapCards();
    card.classList.remove("hidden");
  }

  // Desktop shows the tabbed composer directly; mobile shows a small "tap
  // to open the camera" card instead (see rooms.css .desktop-only /
  // .mobile-only) - CSS decides which is actually visible, so this just
  // needs to unhide both and let the media query sort it out. That also
  // means rotating a tablet mid-session just works, no JS re-check needed.
  function showComposerEntry() {
    closeStoryOverlay();
    hideAllWrapCards();
    els.composerCard.classList.remove("hidden");
    els.mobileComposerCard.classList.remove("hidden");
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

  async function onRoomLoaded() {
    document.title = `rooms. — ${room.name}`;
    els.roomTitle.innerHTML = `📷 ${escapeHtml(room.name)}<span class="dot">.</span>`;
    els.mindmapLink.href = `/r/${CODE}/mindmap`;
    els.mindmapLink.classList.remove("hidden");

    if (room.developed) return renderArchive();

    els.nameRoomTitle.textContent = `Join "${room.name}"`;
    els.composerRoomTitle.textContent = room.name;
    updateComposerHint();

    const savedName = localStorage.getItem(NAME_KEY);
    if (savedName) {
      await joinRoom(savedName);
      showComposerEntry();
    } else {
      show(els.nameCard);
    }

    if (statusPollInterval) clearInterval(statusPollInterval);
    statusPollInterval = setInterval(checkIfDeveloped, 30000);
  }

  async function joinRoom(name) {
    try {
      await fetch(`/api/rooms/${CODE}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
    } catch {
      // non-fatal - worst case this person is missing from the roomate
      // picker/mindmap until their next visit
    }
  }

  async function checkIfDeveloped() {
    try {
      const res = await fetch(`/api/rooms/${CODE}`, { cache: "no-store" });
      if (!res.ok) return;
      const fresh = await res.json();
      room = fresh;
      if (room.developed) {
        clearInterval(statusPollInterval);
        closeStoryOverlay();
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
    const text =
      `Develops ${endsAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} — ` +
      `you won't see what's been added until then. ${room.postCount} shot${room.postCount === 1 ? "" : "s"} on the roll so far.`;
    els.composerHint.textContent = text;
    els.mobileComposerHint.textContent = text;
  }

  // ---------- Name gate ----------
  els.nameSubmit.addEventListener("click", async () => {
    const name = els.nameInput.value.trim();
    if (!name) return (els.nameError.textContent = "Enter a name first.");
    localStorage.setItem(NAME_KEY, name);
    await joinRoom(name);
    showComposerEntry();
  });
  els.nameInput.addEventListener("keydown", (e) => e.key === "Enter" && els.nameSubmit.click());

  // ---------- Desktop composer tabs ----------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentMode = btn.dataset.mode;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".composer-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== currentMode));
      if (currentMode === "drawing") initCanvasOnce();
      els.composerError.textContent = "";
    });
  });

  // ---------- Desktop: optional video attached to a text post ----------
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

  // ---------- Desktop: drawing ----------
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

  async function buildDesktopForm() {
    const form = new FormData();
    form.append("authorName", authorName());
    form.append("type", currentMode);

    if (currentMode === "note") {
      const text = els.noteText.value.trim();
      if (!text && !pendingVideoBlob) throw new Error("Write something or attach a video.");
      form.append("contentText", text);
      if (pendingVideoBlob) form.append("video", pendingVideoBlob, "clip.webm");
    } else if (currentMode === "drawing") {
      if (!hasDrawn) throw new Error("Draw something first.");
      const blob = await new Promise((resolve) => els.drawCanvas.toBlob(resolve, "image/png"));
      form.append("image", blob, "drawing.png");
      form.append("caption", els.drawingCaption.value.trim());
    } else if (currentMode === "song") {
      const url = els.songUrl.value.trim();
      if (!/^https?:\/\/open\.spotify\.com\//i.test(url)) throw new Error("Paste a valid open.spotify.com link.");
      form.append("spotifyUrl", url);
      form.append("caption", els.songCaption.value.trim());
      form.append("lyric", els.songLyric.value.trim());
    }
    return form;
  }

  els.composerNext.addEventListener("click", async () => {
    els.composerError.textContent = "";
    try {
      pendingForm = await buildDesktopForm();
    } catch (err) {
      els.composerError.textContent = err.message;
      return;
    }
    pendingBackTarget = () => show(els.composerCard);
    await showRoomateStep();
  });

  // ---------- Roomate tagging step (shared) ----------
  async function showRoomateStep() {
    els.roomateError.textContent = "";
    selectedRoomates.clear();
    els.roomateList.innerHTML = "";

    let names = [];
    try {
      const res = await fetch(`/api/rooms/${CODE}/participants`, { cache: "no-store" });
      const data = await res.json();
      names = (data.names || []).filter((n) => n !== authorName());
    } catch {
      // if this fails, the list is just empty - posting without tags still works
    }

    els.roomateEmptyHint.classList.toggle("hidden", names.length > 0);
    names.forEach((name) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "roomate-chip";
      chip.textContent = name;
      chip.addEventListener("click", () => {
        if (selectedRoomates.has(name)) {
          selectedRoomates.delete(name);
          chip.classList.remove("selected");
        } else {
          selectedRoomates.add(name);
          chip.classList.add("selected");
        }
      });
      els.roomateList.appendChild(chip);
    });

    show(els.roomateStepCard);
  }

  els.roomateBack.addEventListener("click", () => {
    if (pendingBackTarget) pendingBackTarget();
  });

  els.roomatePostSubmit.addEventListener("click", async () => {
    if (!pendingForm) return;
    els.roomateError.textContent = "";
    pendingForm.append("roomateTags", JSON.stringify(Array.from(selectedRoomates)));

    els.roomatePostSubmit.disabled = true;
    els.roomatePostSubmit.textContent = "Adding…";
    try {
      const res = await fetch(`/api/rooms/${CODE}/posts`, { method: "POST", body: pendingForm });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      room.postCount = data.rollCount;
      els.confirmText.textContent =
        `${data.rollCount} shot${data.rollCount === 1 ? "" : "s"} on the roll now. ` +
        `Nobody — including you — can see any of it until "${room.name}" develops.`;
      resetAfterPost();
      show(els.confirmCard);
    } catch (err) {
      els.roomateError.textContent = err.message || "Couldn't reach the server.";
    } finally {
      els.roomatePostSubmit.disabled = false;
      els.roomatePostSubmit.textContent = "Add to the roll";
    }
  });

  els.postAnother.addEventListener("click", () => {
    updateComposerHint();
    showComposerEntry();
  });

  function resetAfterPost() {
    pendingForm = null;
    pendingBackTarget = null;
    selectedRoomates.clear();
    resetDesktopComposer();
    resetStoryState();
  }

  function resetDesktopComposer() {
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

  // ---------- Mobile story flow: capture -> details -> roomates -> post ----------
  let storyMode = "photo";
  let storyStream = null;
  let storyRecorder = null;
  let storyChunks = [];
  let storyRecStartedAt = 0;
  let storyRecTimerInterval = null;
  let storyFacingMode = "environment";
  let capturedPhotoBlob = null;
  let capturedVideoBlob = null;

  function openStoryOverlay() {
    document.body.style.overflow = "hidden";
    els.storyFlow.classList.remove("hidden");
  }
  function closeStoryOverlay() {
    document.body.style.overflow = "";
    els.storyFlow.classList.add("hidden");
  }
  function showStoryStep(name) {
    document.querySelectorAll(".story-step").forEach((s) => s.classList.toggle("hidden", s.dataset.step !== name));
  }

  function startStoryFlow() {
    hideAllWrapCards();
    resetStoryState();
    openStoryOverlay();
    showStoryStep("capture");
    startStoryCamera();
  }

  function resetStoryState() {
    capturedPhotoBlob = null;
    capturedVideoBlob = null;
    els.storyTitle.value = "";
    els.storyDesc.value = "";
    els.storyPhotoPreview.classList.add("hidden");
    els.storyVideoPreview.classList.add("hidden");
    els.storyReviewActions.classList.add("hidden");
  }

  async function startStoryCamera() {
    els.storyCameraError.classList.add("hidden");
    els.storyCamera.classList.remove("hidden");
    els.storyPhotoPreview.classList.add("hidden");
    els.storyVideoPreview.classList.add("hidden");
    els.storyShutter.classList.remove("hidden", "recording");
    els.storyReviewActions.classList.add("hidden");
    els.storyRecTimer.classList.add("hidden");
    try {
      storyStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: storyFacingMode }, audio: true });
    } catch {
      els.storyCameraError.textContent = "Couldn't access your camera — check your browser's camera permission.";
      els.storyCameraError.classList.remove("hidden");
      els.storyShutter.classList.add("hidden");
      return;
    }
    els.storyCamera.srcObject = storyStream;
  }

  function stopStoryStream() {
    if (storyStream) {
      storyStream.getTracks().forEach((t) => t.stop());
      storyStream = null;
    }
  }

  document.querySelectorAll("#story-mode-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (storyRecorder && storyRecorder.state === "recording") return;
      storyMode = btn.dataset.mode;
      document.querySelectorAll("#story-mode-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  els.storyFlipCamera.addEventListener("click", () => {
    storyFacingMode = storyFacingMode === "environment" ? "user" : "environment";
    stopStoryStream();
    startStoryCamera();
  });

  els.storyClose.addEventListener("click", () => {
    stopStoryStream();
    if (storyRecorder && storyRecorder.state === "recording") storyRecorder.stop();
    clearInterval(storyRecTimerInterval);
    showComposerEntry();
  });

  els.storyShutter.addEventListener("click", () => {
    if (storyMode === "photo") capturePhoto();
    else toggleStoryRecording();
  });

  function capturePhoto() {
    const video = els.storyCamera;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        capturedPhotoBlob = blob;
        els.storyPhotoPreview.src = URL.createObjectURL(blob);
        showStoryReview("photo");
      },
      "image/jpeg",
      0.88
    );
  }

  function toggleStoryRecording() {
    if (storyRecorder && storyRecorder.state === "recording") {
      storyRecorder.stop();
      return;
    }
    storyChunks = [];
    storyRecorder = new MediaRecorder(storyStream);
    storyRecorder.ondataavailable = (e) => e.data.size && storyChunks.push(e.data);
    storyRecorder.onstop = onStoryRecordingStopped;
    storyRecorder.start();
    storyRecStartedAt = Date.now();
    els.storyShutter.classList.add("recording");
    els.storyRecTimer.classList.remove("hidden");
    storyRecTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - storyRecStartedAt) / 1000);
      els.storyRecTimer.textContent = `● ${secs}s`;
      if (Date.now() - storyRecStartedAt >= MAX_RECORD_MS) storyRecorder.stop();
    }, 250);
  }

  function onStoryRecordingStopped() {
    clearInterval(storyRecTimerInterval);
    els.storyRecTimer.classList.add("hidden");
    els.storyShutter.classList.remove("recording");
    capturedVideoBlob = new Blob(storyChunks, { type: storyRecorder.mimeType || "video/webm" });
    els.storyVideoPreview.src = URL.createObjectURL(capturedVideoBlob);
    showStoryReview("video");
  }

  function showStoryReview(kind) {
    stopStoryStream();
    els.storyCamera.classList.add("hidden");
    els.storyShutter.classList.add("hidden");
    els.storyReviewActions.classList.remove("hidden");
    if (kind === "photo") els.storyPhotoPreview.classList.remove("hidden");
    else els.storyVideoPreview.classList.remove("hidden");
  }

  els.storyRetake.addEventListener("click", () => {
    capturedPhotoBlob = null;
    capturedVideoBlob = null;
    els.storyPhotoPreview.classList.add("hidden");
    els.storyVideoPreview.classList.add("hidden");
    els.storyReviewActions.classList.add("hidden");
    startStoryCamera();
  });

  els.storyNext.addEventListener("click", () => {
    els.storyDate.value = todayLocalISODate();
    showStoryStep("details");
  });

  els.storyBackToCapture.addEventListener("click", () => {
    showStoryStep("capture");
    if (!capturedPhotoBlob && !capturedVideoBlob) startStoryCamera();
  });

  function buildStoryForm() {
    const form = new FormData();
    form.append("authorName", authorName());
    form.append("type", "note");
    form.append("title", els.storyTitle.value.trim());
    form.append("contentText", els.storyDesc.value.trim());
    if (els.storyDate.value) form.append("postDate", els.storyDate.value);
    if (capturedVideoBlob) form.append("video", capturedVideoBlob, "story.webm");
    else if (capturedPhotoBlob) form.append("image", capturedPhotoBlob, "story.jpg");
    return form;
  }

  els.storyNextToRoomates.addEventListener("click", async () => {
    els.storyDetailsError.textContent = "";
    pendingForm = buildStoryForm();
    pendingBackTarget = () => {
      hideAllWrapCards();
      openStoryOverlay();
      showStoryStep("details");
    };
    await showRoomateStep();
  });

  function todayLocalISODate() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  document.getElementById("mobile-open-story")?.addEventListener("click", startStoryFlow);

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
      if (p.imageUrl) body += `<img src="${p.imageUrl}" alt="photo" />`;
    } else if (p.type === "drawing") {
      body = `<img src="${p.imageUrl}" alt="drawing" />`;
      if (p.caption) body += `<p class="post-text">${escapeHtml(p.caption)}</p>`;
    } else if (p.type === "song") {
      body = `<iframe src="${p.embedUrl}" height="152" allow="encrypted-media" loading="lazy"></iframe>`;
      if (p.caption) body += `<p class="post-text">${escapeHtml(p.caption)}</p>`;
      if (p.lyric) body += `<p class="post-lyric">"${escapeHtml(p.lyric)}"</p>`;
    }
    const title = p.title ? `<h3 class="post-title">${escapeHtml(p.title)}</h3>` : "";
    const dateLabel = p.postDate ? `<span class="post-date-label">📅 ${escapeHtml(p.postDate)}</span>` : "";
    const roomates =
      p.roomateTags && p.roomateTags.length
        ? `<p class="post-roomates">with ${p.roomateTags.map(escapeHtml).join(", ")}</p>`
        : "";
    return `
      <div class="post-card">
        <div class="post-meta"><span class="post-author">${escapeHtml(p.authorName)}</span><span>${when} ${dateLabel}</span></div>
        ${title}
        ${body}
        ${roomates}
      </div>`;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  boot();
})();
