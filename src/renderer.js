// NOCTURNE desktop renderer — drives the Python backend over localhost.
const PORT = location.hash.slice(1) || "8770";
const API = `http://127.0.0.1:${PORT}/api`;

const $ = (s) => document.querySelector(s);
const api = (p, opts) => fetch(API + p, opts).then((r) => r.json());
const post = (p, body) =>
  fetch(API + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });

const fmt = (s) => {
  s = Math.max(0, s | 0);
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`;
};

let curList = []; // tracks shown in the main list (becomes the play queue)
let nowId = null;
let view = "search";

// ── add an align button into the player bar (next to lyrics) ───────────────
const alignBtn = document.createElement("button");
alignBtn.id = "align-btn";
alignBtn.title = "AI-align lyrics to this audio";
alignBtn.textContent = "⟁";
$(".right").insertBefore(alignBtn, $("#lyrics-btn").nextSibling);

// ── toast ──────────────────────────────────────────────────────────────────
let toastEl = null,
  toastT = 0;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.remove("hide");
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.add("hide"), 2600);
}

// ── track list rendering ───────────────────────────────────────────────────
function renderList(tracks) {
  curList = tracks || [];
  const list = $("#list");
  list.innerHTML = "";
  if (!curList.length) {
    list.innerHTML = `<div class="empty">nothing here</div>`;
    return;
  }
  curList.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "row" + (t.video_id === nowId ? " playing" : "");
    row.dataset.vid = t.video_id;
    const badge = t.source === "sc" ? `<span class="r-badge">☁</span>` : "";
    row.innerHTML = `
      <img class="r-thumb" src="${t.thumb || ""}" loading="lazy" />
      <div class="r-main">
        <div class="r-title">${esc(t.title)}${badge}</div>
        <div class="r-sub">${esc(t.artist)}${t.album ? " · " + esc(t.album) : ""}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <button class="r-add" title="add to queue">＋</button>
        <span class="r-dur">${esc(t.duration || "")}</span>
      </div>`;
    row.addEventListener("dblclick", () => playFrom(i));
    row.querySelector(".r-add").addEventListener("click", (e) => {
      e.stopPropagation();
      post("/enqueue", { tracks: [t] });
      toast("added to queue: " + t.title);
    });
    list.appendChild(row);
  });
}
const esc = (s) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function playFrom(index) {
  post("/play", { tracks: curList, index });
}

// ── views ──────────────────────────────────────────────────────────────────
function setView(v) {
  view = v;
  document.querySelectorAll(".nav").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === v));
  $("#searchbar").classList.toggle("hidden", v !== "search");
  if (v === "library") {
    $("#list").innerHTML = `<div class="empty">loading library…</div>`;
    api("/library").then(renderList);
  } else if (v === "search") {
    $("#search-input").focus();
  }
}
document.querySelectorAll(".nav").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.view)));

// search (debounced on input, instant on enter)
let searchT = 0;
$("#search-input").addEventListener("input", (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  if (!q) return;
  searchT = setTimeout(() => doSearch(q), 350);
});
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchT);
    doSearch(e.target.value.trim());
  }
});
function doSearch(q) {
  if (!q) return;
  $("#list").innerHTML = `<div class="empty">searching…</div>`;
  api("/search?q=" + encodeURIComponent(q)).then((yt) => {
    renderList(yt);
    // fold in SoundCloud a beat later
    api("/sc_search?q=" + encodeURIComponent(q)).then((sc) => {
      if (sc && sc.length && view === "search") renderList(yt.concat(sc));
    });
  });
}

// playlists
function loadPlaylists() {
  api("/playlists").then((pls) => {
    const box = $("#playlists");
    box.innerHTML = "";
    (pls || []).forEach((pl) => {
      const d = document.createElement("div");
      d.className = "pl-item";
      d.textContent = pl.title;
      d.title = pl.title;
      d.addEventListener("click", () => {
        setView("none");
        $("#searchbar").classList.add("hidden");
        $("#list").innerHTML = `<div class="empty">loading…</div>`;
        api("/playlist?id=" + encodeURIComponent(pl.id)).then(renderList);
      });
      box.appendChild(d);
    });
  });
}

// ── controls ───────────────────────────────────────────────────────────────
$("#toggle").addEventListener("click", () => post("/toggle"));
$("#next").addEventListener("click", () => post("/next"));
$("#prev").addEventListener("click", () => post("/prev"));
$("#bar").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (lastDur > 0) post("/seek", { pos: ((e.clientX - r.left) / r.width) * lastDur });
});
$("#vol").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const v = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100);
  $("#vol-fill").style.width = v + "%";
  post("/volume", { volume: v });
});
alignBtn.addEventListener("click", () => {
  post("/align");
  toast("⟁ aligning lyrics to this audio — ~15s");
});

// ── visualizer (live FFT bars off the backend's SpectrumTap) ───────────────
const vizBtn = document.createElement("button");
vizBtn.id = "viz-btn";
vizBtn.title = "visualizer (v)";
vizBtn.textContent = "viz";
$(".right").insertBefore(vizBtn, $("#lyrics-btn"));

let vizOn = false,
  vizRAF = 0,
  vizFetchT = 0,
  vizLevels = [],
  vizSmooth = [];
const NBARS = 56;
const vizCanvas = $("#viz");
const vctx = vizCanvas.getContext("2d");

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toggleViz() {
  vizOn = !vizOn;
  vizBtn.classList.toggle("active", vizOn);
  vizCanvas.classList.toggle("hidden", !vizOn);
  if (vizOn) {
    sizeViz();
    vizLoop();
  } else {
    cancelAnimationFrame(vizRAF);
  }
}
vizBtn.addEventListener("click", toggleViz);

function sizeViz() {
  const r = vizCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  vizCanvas.width = Math.max(1, r.width * dpr);
  vizCanvas.height = Math.max(1, r.height * dpr);
}
window.addEventListener("resize", () => {
  if (vizOn) sizeViz();
});

function vizLoop() {
  if (!vizOn) return;
  const now = performance.now();
  if (now - vizFetchT > 45) {
    vizFetchT = now;
    api("/spectrum?n=" + NBARS)
      .then((d) => {
        vizLevels = d.levels || [];
      })
      .catch(() => {});
  }
  drawViz();
  vizRAF = requestAnimationFrame(vizLoop);
}

function drawViz() {
  const W = vizCanvas.width,
    H = vizCanvas.height;
  vctx.clearRect(0, 0, W, H);
  if (!vizLevels.length) return;
  const n = vizLevels.length;
  if (vizSmooth.length !== n) vizSmooth = new Array(n).fill(0);
  const pink = cssVar("--pink") || "#ff5e7d";
  const orange = cssVar("--orange") || "#ff8a29";
  const grad = vctx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, pink);
  grad.addColorStop(1, orange);
  vctx.fillStyle = grad;
  const gap = W / n;
  const bw = gap * 0.62;
  for (let i = 0; i < n; i++) {
    // ease toward the latest level; decay a touch slower than attack
    const t = vizLevels[i] || 0;
    vizSmooth[i] += (t - vizSmooth[i]) * (t > vizSmooth[i] ? 0.5 : 0.18);
    const h = Math.max(2, vizSmooth[i] * H * 0.92);
    const x = i * gap + (gap - bw) / 2;
    const rad = Math.min(bw / 2, 6);
    roundBar(x, H - h, bw, h, rad);
  }
}
function roundBar(x, y, w, h, r) {
  vctx.beginPath();
  vctx.moveTo(x, y + h);
  vctx.lineTo(x, y + r);
  vctx.arcTo(x, y, x + r, y, r);
  vctx.lineTo(x + w - r, y);
  vctx.arcTo(x + w, y, x + w, y + r, r);
  vctx.lineTo(x + w, y + h);
  vctx.closePath();
  vctx.fill();
}

// ── lyrics ─────────────────────────────────────────────────────────────────
let lyricsOpen = false;
let lyricLines = null,
  lyricSynced = false,
  lyricVid = null,
  lyricEls = [],
  lastCur = -1;
// ── panels (only one of main / lyrics / queue visible) ─────────────────────
let panel = "main";
function setPanel(p) {
  panel = p;
  $("#main").style.display = p === "main" ? "flex" : "none";
  $("#lyrics-pane").classList.toggle("hidden", p !== "lyrics");
  $("#queue-pane").classList.toggle("hidden", p !== "queue");
  $("#lyrics-btn").classList.toggle("active", p === "lyrics");
  $("#queue-btn").classList.toggle("active", p === "queue");
  lyricsOpen = p === "lyrics";
  if (p === "lyrics") refreshLyrics(true);
  if (p === "queue") loadQueue();
}
$("#lyrics-btn").addEventListener("click", () =>
  setPanel(panel === "lyrics" ? "main" : "lyrics"));
$("#queue-btn").addEventListener("click", () =>
  setPanel(panel === "queue" ? "main" : "queue"));

// ── queue panel ────────────────────────────────────────────────────────────
function loadQueue() {
  api("/queue").then((q) => {
    const box = $("#queue-list");
    box.innerHTML = "";
    if (!q || !q.length) {
      box.innerHTML = `<div class="empty">queue is empty</div>`;
      return;
    }
    q.forEach((t, i) => {
      const d = document.createElement("div");
      d.className = "q-row" + (t.video_id === nowId ? " playing" : "");
      d.innerHTML = `<div class="q-idx">${i + 1}</div>
        <div><div class="q-title">${esc(t.title)}</div>
        <div class="q-sub">${esc(t.artist)}</div></div>
        <div class="q-sub">${esc(t.duration || "")}</div>`;
      d.addEventListener("dblclick", () =>
        post("/queue_jump", { index: i }).then(() => setTimeout(loadQueue, 350)));
      box.appendChild(d);
    });
  });
}

// ── themes (the 7 ytm.py palettes) ─────────────────────────────────────────
let themes = [],
  themeI = 0;
function applyTheme(t) {
  const rgb = (a) => `rgb(${a[0]},${a[1]},${a[2]})`;
  const r = document.documentElement.style;
  r.setProperty("--red", rgb(t.red));
  r.setProperty("--orange", rgb(t.orange));
  r.setProperty("--pink", rgb(t.pink));
  r.setProperty("--accent", rgb(t.pink));
}
api("/themes").then((ts) => {
  themes = ts || [];
  themeI = (+(localStorage.getItem("noct-theme") || 0) || 0) % (themes.length || 1);
  if (themes.length) applyTheme(themes[themeI]);
});
function cycleTheme() {
  if (!themes.length) return;
  themeI = (themeI + 1) % themes.length;
  applyTheme(themes[themeI]);
  localStorage.setItem("noct-theme", themeI);
  toast("theme: " + themes[themeI].name);
}

// ── transport extras (like / shuffle / repeat) ─────────────────────────────
$("#like").addEventListener("click", () => post("/like"));
$("#shuffle").addEventListener("click", () => {
  post("/shuffle").then(() => panel === "queue" && setTimeout(loadQueue, 200));
  toast("shuffled");
});
$("#repeat").addEventListener("click", () => post("/repeat"));
function refreshLyrics(force) {
  if (!nowId) return;
  if (!force && lyricVid === nowId) return;
  lyricVid = nowId;
  lyricLines = null;
  lyricEls = [];
  lastCur = -1;
  $("#lyrics-scroll").innerHTML = `<div class="ly-msg">loading lyrics…</div>`;
  pollLyrics();
}
function pollLyrics() {
  if (!lyricVid) return;
  api("/lyrics?video_id=" + encodeURIComponent(lyricVid)).then((d) => {
    if (lyricVid !== nowId) return;
    if (d.state === "loading") {
      setTimeout(pollLyrics, 700);
    } else if (d.state === "ok") {
      lyricLines = d.lines;
      lyricSynced = d.synced;
      drawLyrics();
    } else {
      $("#lyrics-scroll").innerHTML =
        `<div class="ly-msg">no lyrics — ⟁ to align to this audio</div>`;
    }
  });
}
function drawLyrics() {
  const box = $("#lyrics-scroll");
  box.innerHTML = "";
  lyricEls = lyricLines.map(([, txt]) => {
    const d = document.createElement("div");
    d.className = "ly";
    d.textContent = txt || "♪";
    box.appendChild(d);
    return d;
  });
  lastCur = -1;
}
function updateLyricHighlight(pos, dur) {
  if (!lyricsOpen || !lyricLines || !lyricEls.length) return;
  let cur;
  if (lyricSynced) {
    cur = 0;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i][0] <= pos) cur = i;
      else break;
    }
  } else {
    cur = dur ? Math.min(lyricLines.length - 1, (((pos / dur) * lyricLines.length) | 0)) : 0;
  }
  if (cur === lastCur) return;
  lastCur = cur;
  lyricEls.forEach((el, i) => {
    el.classList.toggle("cur", i === cur);
    el.classList.toggle("near", Math.abs(i - cur) === 1);
  });
  const el = lyricEls[cur];
  if (el)
    $("#lyrics-scroll").scrollTo({
      top: el.offsetTop - $("#lyrics-scroll").clientHeight / 2 + el.clientHeight / 2,
      behavior: "smooth",
    });
}

// ── live state poll ──────────────────────────────────────────────────────────
let lastDur = 0;
function poll() {
  api("/state")
    .then((s) => {
      const n = s.now;
      const id = n ? n.video_id : null;
      if (id !== nowId) {
        nowId = id;
        document.querySelectorAll(".row").forEach((r) =>
          r.classList.toggle("playing", r.dataset.vid === nowId));
        if (lyricsOpen) refreshLyrics(true);
      }
      // now-playing meta
      $("#np-title").textContent = n ? n.title : "—";
      $("#np-artist").textContent = n ? n.artist : "";
      const art = n && n.thumb ? n.thumb : "";
      if ($("#np-art").src !== art) $("#np-art").src = art;
      if (lyricsOpen) {
        $("#lyrics-art").style.backgroundImage = art ? `url("${art}")` : "";
        $("#lyrics-title").textContent = n ? n.title : "";
        $("#lyrics-artist").textContent = n ? n.artist : "";
      }
      connLost = false;
      // transport
      lastDur = s.dur || 0;
      $("#toggle").textContent = s.paused || !n ? "▶" : "⏸";
      $("#toggle").style.paddingLeft = s.paused || !n ? "2px" : "0";
      $("#t-cur").textContent = fmt(s.pos);
      $("#t-dur").textContent = fmt(s.dur);
      $("#bar-fill").style.width = s.dur ? (s.pos / s.dur) * 100 + "%" : "0";
      $("#vol-fill").style.width = (s.volume || 0) + "%";
      alignBtn.style.color = s.aligning ? "var(--orange)" : "";
      // like / shuffle / repeat reflect backend truth
      const like = $("#like");
      like.classList.toggle("hidden", !s.likeable);
      like.classList.toggle("liked", !!s.liked);
      like.textContent = s.liked ? "♥" : "♡";
      $("#shuffle").classList.toggle("on", !!s.shuffle);
      const rep = $("#repeat");
      rep.classList.toggle("on", s.repeat > 0);
      rep.innerHTML = "🔁" + (s.repeat === 2 ? '<span class="badge">1</span>' : "");
      rep.title = ["repeat off", "repeat all", "repeat one"][s.repeat] || "repeat";
      updateLyricHighlight(s.pos, s.dur);
    })
    .catch(() => {
      if (!connLost) {
        connLost = true;
        toast("backend unreachable — is it running?");
      }
    })
    .finally(() => setTimeout(poll, 250));
}
let connLost = false;

// ── volume persistence ───────────────────────────────────────────────────────
const savedVol = localStorage.getItem("noct-vol");
if (savedVol !== null) post("/volume", { volume: +savedVol });
$("#vol").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const v = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100);
  localStorage.setItem("noct-vol", v);
});

// ── boot ─────────────────────────────────────────────────────────────────────
loadPlaylists();
setView("search");
poll();

// keys
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (e.code === "Space") { e.preventDefault(); post("/toggle"); }
  else if (e.key === "ArrowRight" && e.shiftKey) post("/next");
  else if (e.key === "ArrowLeft" && e.shiftKey) post("/prev");
  else if (k === "l") setPanel(panel === "lyrics" ? "main" : "lyrics");
  else if (k === "q") setPanel(panel === "queue" ? "main" : "queue");
  else if (k === "v") toggleViz();
  else if (k === "c") cycleTheme();
  else if (k === "r") post("/repeat");
  else if (k === "s") { post("/shuffle"); toast("shuffled"); }
  else if (k === "y") post("/like");
});
