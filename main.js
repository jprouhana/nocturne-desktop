// NOCTURNE desktop — Electron shell. Spawns the Python backend (which reuses
// ytm.py's core) and renders the GUI that drives it over localhost.
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = Number(process.env.NOCTURNE_PORT || 8770);
let backend = null;

// play nice with Wayland / Hyprland: native Wayland surface (crisp, no
// XWayland blur), and tolerate the laptop GPU without hard-failing
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");

function venvPython() {
  const p = path.join(process.env.HOME, "ytm-tui", ".venv", "bin", "python");
  return fs.existsSync(p) ? p : "python3";
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
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#08080d",
    title: "NOCTURNE",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "src", "index.html"), {
    hash: String(PORT),
  });
  // open external links (e.g. sign-in help) in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  startBackend();
  waitForBackend(createWindow);
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
app.on("before-quit", killBackend);
