// NOCTURNE desktop — Electron shell. Spawns the Python backend (which reuses
// ytm.py's core) and renders the GUI that drives it over localhost.
const { app, BrowserWindow, shell, globalShortcut, Tray, Menu, nativeImage } =
  require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = Number(process.env.NOCTURNE_PORT || 8770);
let backend = null;
let tray = null;

// fire-and-forget POST to the backend — used by media keys + the tray menu
// so playback responds even when the window isn't focused.
function post(p) {
  const req = http.request(
    { host: "127.0.0.1", port: PORT, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": 2 } },
    (r) => r.resume(),
  );
  req.on("error", () => {});
  req.end("{}");
}

// play nice with Wayland / Hyprland: native Wayland surface (crisp, no
// XWayland blur), and tolerate the laptop GPU without hard-failing
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");

// the desktop app reuses the terminal app's venv + ytm.py. find its python
// across platforms; NOCTURNE_PY / NOCTURNE_YTM env vars override.
function venvPython() {
  if (process.env.NOCTURNE_PY) return process.env.NOCTURNE_PY;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cands = [
    path.join(home, "ytm-tui", ".venv", "bin", "python"), // linux/mac
    path.join(home, "ytm-tui", ".venv", "Scripts", "python.exe"), // windows
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}

// remember window size/position between launches
function statePath() {
  return path.join(app.getPath("userData"), "window.json");
}
function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch (e) {
    return null;
  }
}
function saveBounds(win) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(win.getBounds()));
  } catch (e) {}
}

function startBackend() {
  backend = spawn(venvPython(), [path.join(__dirname, "backend.py")], {
    env: { ...process.env, NOCTURNE_PORT: String(PORT) },
    stdio: "inherit",
  });
  backend.on("exit", (c) => console.log("backend exited", c));
}

function waitForBackend(cb, tries = 0) {
  http
    .get(`http://127.0.0.1:${PORT}/api/state`, (r) => {
      r.resume();
      cb();
    })
    .on("error", () => {
      if (tries > 80) return cb();
      setTimeout(() => waitForBackend(cb, tries + 1), 200);
    });
}

function createWindow() {
  const b = loadBounds();
  const win = new BrowserWindow({
    width: (b && b.width) || 1240,
    height: (b && b.height) || 820,
    x: b && b.x,
    y: b && b.y,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#08080d",
    title: "NOCTURNE",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  ["resize", "move"].forEach((ev) => win.on(ev, () => saveBounds(win)));
  win.loadFile(path.join(__dirname, "src", "index.html"), {
    hash: String(PORT),
  });
  // open external links (e.g. sign-in help) in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// OS media keys (play/pause, next, prev, stop) — global, so they work even
// when NOCTURNE isn't the focused window. Hyprland/most DEs forward the
// hardware keys here; on Wayland a compositor may swallow them, hence the
// per-key try so one failure doesn't sink the rest.
function registerMediaKeys() {
  const binds = {
    MediaPlayPause: () => post("/api/toggle"),
    MediaNextTrack: () => post("/api/next"),
    MediaPreviousTrack: () => post("/api/prev"),
    MediaStop: () => post("/api/toggle"),
  };
  for (const [key, fn] of Object.entries(binds)) {
    try {
      globalShortcut.register(key, fn);
    } catch (e) {}
  }
}

// system tray: quick transport controls + show/quit without the window
function createTray() {
  try {
    const icon = nativeImage.createFromPath(
      path.join(__dirname, "assets", "tray.png"),
    );
    tray = new Tray(icon);
    tray.setToolTip("NOCTURNE");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Play / Pause", click: () => post("/api/toggle") },
        { label: "Next", click: () => post("/api/next") },
        { label: "Previous", click: () => post("/api/prev") },
        { type: "separator" },
        {
          label: "Show NOCTURNE",
          click: () => {
            const w = BrowserWindow.getAllWindows()[0];
            if (w) (w.isVisible() ? w.focus() : w.show());
            else createWindow();
          },
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    // left-click the tray = raise the window
    tray.on("click", () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) (w.isVisible() ? w.focus() : w.show());
      else createWindow();
    });
  } catch (e) {
    console.log("tray init failed", e && e.message);
  }
}

app.whenReady().then(() => {
  startBackend();
  waitForBackend(createWindow);
  registerMediaKeys();
  createTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function killBackend() {
  if (backend) {
    try {
      backend.kill();
    } catch (e) {}
    backend = null;
  }
}
app.on("window-all-closed", () => {
  killBackend();
  app.quit();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", killBackend);
