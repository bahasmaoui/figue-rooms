(() => {
  "use strict";

  const KEY_STORAGE = "figue-rooms-admin-key";

  const gateCard = document.getElementById("gate-card");
  const gateKeyInput = document.getElementById("gate-key");
  const gateSubmit = document.getElementById("gate-submit");
  const gateError = document.getElementById("gate-error");

  const formCard = document.getElementById("form-card");
  const nameInput = document.getElementById("room-name");
  const endsInput = document.getElementById("room-ends");
  const createSubmit = document.getElementById("create-submit");
  const formError = document.getElementById("form-error");

  const resultCard = document.getElementById("result-card");
  const inviteLink = document.getElementById("invite-link");
  const inviteQr = document.getElementById("invite-qr");
  const copyLinkBtn = document.getElementById("copy-link");
  const anotherRoomBtn = document.getElementById("another-room");

  function adminKey() {
    return localStorage.getItem(KEY_STORAGE) || "";
  }

  function showForm() {
    gateCard.classList.add("hidden");
    resultCard.classList.add("hidden");
    formCard.classList.remove("hidden");
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    endsInput.value = soon.toISOString().slice(0, 16);
  }

  if (adminKey()) showForm();

  gateSubmit.addEventListener("click", () => {
    const key = gateKeyInput.value.trim();
    if (!key) return;
    localStorage.setItem(KEY_STORAGE, key);
    gateError.textContent = "";
    showForm();
  });
  gateKeyInput.addEventListener("keydown", (e) => e.key === "Enter" && gateSubmit.click());

  createSubmit.addEventListener("click", async () => {
    formError.textContent = "";
    const name = nameInput.value.trim();
    const endsAt = endsInput.value;
    if (!name) return (formError.textContent = "Give the room a name.");
    if (!endsAt) return (formError.textContent = "Pick when it develops.");

    createSubmit.disabled = true;
    createSubmit.textContent = "Creating…";
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey() },
        body: JSON.stringify({ name, endsAt: new Date(endsAt).toISOString() }),
      });
      if (res.status === 401) {
        localStorage.removeItem(KEY_STORAGE);
        gateError.textContent = "That admin key isn't right.";
        formCard.classList.add("hidden");
        gateCard.classList.remove("hidden");
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      inviteLink.textContent = data.joinUrl;
      renderQr(data.joinUrl);
      formCard.classList.add("hidden");
      resultCard.classList.remove("hidden");
    } catch (err) {
      formError.textContent = err.message || "Couldn't reach the server.";
    } finally {
      createSubmit.disabled = false;
      createSubmit.textContent = "Create room";
    }
  });

  function renderQr(url) {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    inviteQr.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
  }

  copyLinkBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteLink.textContent);
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyLinkBtn.textContent = "Copy link"), 1500);
    } catch {
      // clipboard API unavailable - the link is still selectable/visible as text
    }
  });

  anotherRoomBtn.addEventListener("click", () => {
    nameInput.value = "";
    showForm();
  });
})();
