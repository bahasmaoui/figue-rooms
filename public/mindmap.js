(() => {
  "use strict";

  // Path is /r/:code/mindmap
  const CODE = location.pathname.split("/").filter(Boolean)[1];
  const W = 600;
  const H = 450;

  const els = {
    roomTitle: document.getElementById("room-title"),
    backLink: document.getElementById("back-link"),
    loadingCard: document.getElementById("loading-card"),
    loadingText: document.getElementById("loading-text"),
    notfoundCard: document.getElementById("notfound-card"),
    graphCard: document.getElementById("graph-card"),
    graphHint: document.getElementById("graph-hint"),
    svg: document.getElementById("mindmap-svg"),
    edgesGroup: document.getElementById("mindmap-edges"),
    nodesGroup: document.getElementById("mindmap-nodes"),
    emptyHint: document.getElementById("mindmap-empty-hint"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    modalTitle: document.getElementById("modal-title"),
    modalBody: document.getElementById("modal-body"),
    modalClose: document.getElementById("modal-close"),
  };

  els.backLink.href = `/r/${CODE}`;

  let nodes = [];
  let edges = [];
  let developed = false;
  let archivePosts = null; // fetched lazily, only once developed and only on first click
  let alpha = 1;
  let animFrame = null;
  let didDrag = false;

  async function boot() {
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const res = await fetch(`/api/rooms/${CODE}/mindmap`, { cache: "no-store" });
        if (res.status === 404) return show(els.notfoundCard);
        if (!res.ok) throw new Error("bad status");
        onData(await res.json());
        return;
      } catch {
        els.loadingText.textContent =
          attempt < 3
            ? "Waking up the room… this can take up to a minute if it's been quiet for a while."
            : `Still waking up… (attempt ${attempt})`;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  function show(card) {
    [els.loadingCard, els.notfoundCard, els.graphCard].forEach((c) => c.classList.add("hidden"));
    card.classList.remove("hidden");
  }

  function onData(data) {
    document.title = `rooms. — ${data.name} mindmap`;
    els.roomTitle.innerHTML = `📷 ${escapeHtml(data.name)}<span class="dot">.</span>`;
    developed = data.developed;
    els.graphHint.textContent = developed
      ? "Tap a person or a connection to see the posts behind it."
      : "This only shows who's connected, not what was posted — everything stays sealed until the room develops.";

    show(els.graphCard);

    if (data.nodes.length === 0) {
      els.emptyHint.textContent = "Nobody's joined this room yet.";
      els.emptyHint.classList.remove("hidden");
      return;
    }
    els.emptyHint.classList.toggle("hidden", data.edges.length > 0);

    const nodeByName = new Map();
    const cx = W / 2;
    const cy = H / 2;
    const ring = Math.min(W, H) / 2 - 60;
    nodes = data.nodes.map((n, i) => {
      const angle = (i / data.nodes.length) * Math.PI * 2;
      const node = {
        name: n.name,
        postCount: n.postCount,
        postIds: n.postIds || [],
        x: cx + Math.cos(angle) * ring * (0.4 + Math.random() * 0.6),
        y: cy + Math.sin(angle) * ring * (0.4 + Math.random() * 0.6),
        vx: 0,
        vy: 0,
        r: 14 + Math.min(n.postCount, 8) * 2,
        fixed: false,
      };
      nodeByName.set(n.name, node);
      return node;
    });
    edges = data.edges
      .map((e) => ({ ...e, nodeA: nodeByName.get(e.a), nodeB: nodeByName.get(e.b) }))
      .filter((e) => e.nodeA && e.nodeB);

    buildSvg();
    alpha = 1;
    if (animFrame) cancelAnimationFrame(animFrame);
    tick();
  }

  function buildSvg() {
    els.edgesGroup.innerHTML = "";
    els.nodesGroup.innerHTML = "";

    edges.forEach((e) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "mindmap-edge" + (developed ? " clickable" : ""));
      line.setAttribute("stroke-width", String(1 + Math.min(e.weight, 6)));
      if (developed) line.addEventListener("click", () => openEdgeModal(e));
      els.edgesGroup.appendChild(line);
      e.el = line;
    });

    nodes.forEach((n) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("class", "mindmap-node-circle");
      circle.setAttribute("r", String(n.r));
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "mindmap-node-label");
      label.setAttribute("dy", String(n.r + 14));
      label.textContent = n.name;
      g.appendChild(circle);
      g.appendChild(label);
      els.nodesGroup.appendChild(g);
      n.el = g;

      g.addEventListener("pointerdown", (evt) => startDrag(n, evt));
      circle.addEventListener("click", () => {
        if (didDrag || !developed) return;
        openNodeModal(n);
      });
    });

    render();
  }

  function svgPoint(evt) {
    const rect = els.svg.getBoundingClientRect();
    return { x: ((evt.clientX - rect.left) / rect.width) * W, y: ((evt.clientY - rect.top) / rect.height) * H };
  }

  function startDrag(node, evt) {
    evt.preventDefault();
    didDrag = false;
    node.fixed = true;
    alpha = Math.max(alpha, 0.4);

    const move = (e) => {
      didDrag = true;
      const p = svgPoint(e);
      node.x = p.x;
      node.y = p.y;
      alpha = Math.max(alpha, 0.3);
      if (!animFrame) tick();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      node.fixed = false;
      setTimeout(() => (didDrag = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function tick() {
    simulateStep();
    render();
    if (alpha > 0.01) {
      alpha *= 0.985;
      animFrame = requestAnimationFrame(tick);
    } else {
      animFrame = null;
    }
  }

  function simulateStep() {
    const REPULSION = 2600;
    const SPRING = 0.02;
    const IDEAL_LEN = 130;
    const CENTER_PULL = 0.02;
    const cx = W / 2;
    const cy = H / 2;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a.fixed) continue;
      let fx = 0;
      let fy = 0;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        const force = (REPULSION * alpha) / distSq;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
      fx += (cx - a.x) * CENTER_PULL * alpha;
      fy += (cy - a.y) * CENTER_PULL * alpha;
      a.vx = (a.vx + fx) * 0.8;
      a.vy = (a.vy + fy) * 0.8;
    }

    edges.forEach((e) => {
      const a = e.nodeA;
      const b = e.nodeB;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      // More shared posts pull a pair a little closer together, so tightly
      // connected people visibly cluster rather than sitting at a uniform
      // distance regardless of how strong the connection is.
      const targetLen = IDEAL_LEN / (1 + Math.min(e.weight - 1, 3) * 0.25);
      const force = (dist - targetLen) * SPRING * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.fixed) {
        b.vx -= fx;
        b.vy -= fy;
      }
    });

    nodes.forEach((n) => {
      if (n.fixed) return;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(n.r, Math.min(W - n.r, n.x));
      n.y = Math.max(n.r, Math.min(H - n.r, n.y));
    });
  }

  function render() {
    edges.forEach((e) => {
      e.el.setAttribute("x1", e.nodeA.x);
      e.el.setAttribute("y1", e.nodeA.y);
      e.el.setAttribute("x2", e.nodeB.x);
      e.el.setAttribute("y2", e.nodeB.y);
    });
    nodes.forEach((n) => n.el.setAttribute("transform", `translate(${n.x}, ${n.y})`));
  }

  // ---------- Modals: only meaningful once developed (posts are 403 until then) ----------
  async function ensureArchive() {
    if (archivePosts) return archivePosts;
    const res = await fetch(`/api/rooms/${CODE}/archive`, { cache: "no-store" });
    const data = await res.json();
    archivePosts = data.posts || [];
    return archivePosts;
  }

  async function openNodeModal(node) {
    const posts = (await ensureArchive()).filter((p) => node.postIds.includes(p.id));
    els.modalTitle.textContent = node.name;
    renderModalPosts(posts, `${posts.length} post${posts.length === 1 ? "" : "s"} involving ${node.name}.`);
  }

  async function openEdgeModal(edge) {
    const ids = edge.postIds || [];
    const posts = (await ensureArchive()).filter((p) => ids.includes(p.id));
    els.modalTitle.textContent = `${edge.a} & ${edge.b}`;
    renderModalPosts(posts, `${posts.length} post${posts.length === 1 ? "" : "s"} connect ${edge.a} and ${edge.b}.`);
  }

  function renderModalPosts(posts, summary) {
    els.modalBody.innerHTML = `<p class="hint">${escapeHtml(summary)}</p>` + posts.map(renderMiniPost).join("");
    els.modalBackdrop.classList.remove("hidden");
  }

  function renderMiniPost(p) {
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
    }
    return `<div class="post-card"><div class="post-meta"><span class="post-author">${escapeHtml(p.authorName)}</span><span>${when}</span></div>${body}</div>`;
  }

  els.modalClose.addEventListener("click", () => els.modalBackdrop.classList.add("hidden"));
  els.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.modalBackdrop) els.modalBackdrop.classList.add("hidden");
  });

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  boot();
})();
