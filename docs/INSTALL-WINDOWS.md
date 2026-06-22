# NOCTURNE desktop — Windows install

Runs natively on Windows (no WSL needed for the desktop app — the GUI is a
normal Windows program and the backend uses native Python). You install three
things: the **core** (`ytm.py` + Python deps), **mpv**, and **Node**.

> The terminal NOCTURNE's fancy in-terminal rendering wants WSL, but the
> desktop app only needs the *core* (ytmusicapi / mpv / yt-dlp), which runs
> fine on native Windows Python.

## 1. Prerequisites
Install with [winget](https://learn.microsoft.com/windows/package-manager/) (or
download each):
```powershell
winget install Python.Python.3.12
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg          # yt-dlp needs ffmpeg
winget install mpv.mpv              # or: scoop install mpv
winget install Git.Git
```
Close and reopen PowerShell so the new `python`, `node`, `mpv`, `git` are on PATH.
Verify: `python --version`, `node --version`, `mpv --version`.

## 2. The core (ytm.py + sign-in)
```powershell
git clone https://github.com/jprouhana/nocturne $env:USERPROFILE\ytm-tui
cd $env:USERPROFILE\ytm-tui
python -m venv .venv
.\.venv\Scripts\pip install --upgrade ytmusicapi pillow numpy yt-dlp
# sign in to YouTube Music (browser-cookie wizard)
.\.venv\Scripts\python ytm.py --login
```
`--login` writes your auth to `%USERPROFILE%\.config\ytm-tui\` (local only).
SoundCloud is optional: `.\.venv\Scripts\python ytm.py --sc-login`.

## 3. The desktop app
```powershell
git clone https://github.com/jprouhana/nocturne-desktop $env:USERPROFILE\nocturne-desktop
cd $env:USERPROFILE\nocturne-desktop
npm install
npm start
```
`main.js` auto-detects `%USERPROFILE%\ytm-tui\.venv\Scripts\python.exe`. If your
core lives elsewhere, set the overrides before `npm start`:
```powershell
$env:NOCTURNE_PY  = "C:\path\to\.venv\Scripts\python.exe"
$env:NOCTURNE_YTM = "C:\path\to\ytm.py"
npm start
```

## Notes / limits on Windows
- **Search, library, playback, lyrics, themes, queue, like — all work.**
- **`⟁ AI-align`** is **not** available on Windows (it shells out to a bash
  helper + faster-whisper). Everything else is unaffected.
- The **visualizer** needs a way to capture the system audio. The bundled
  spectrum tap targets PulseAudio/CoreAudio; on plain Windows the bars stay flat
  unless you route output through a loopback (e.g. VB-CABLE) and adapt
  `SpectrumTap` — playback itself is unaffected.
- If `mpv` isn't found, make sure `mpv.exe` is on PATH (reopen the terminal).

## Troubleshooting
- **Window opens but says "backend unreachable"** → the Python backend failed to
  start. Run it by hand to see the error:
  `cd nocturne-desktop; $env:USERPROFILE\ytm-tui\.venv\Scripts\python backend.py`
- **Playback never starts** → stale yt-dlp. `\.venv\Scripts\pip install -U yt-dlp`.
- **Sign-in errors** → re-run `python ytm.py --login`; cookies rotate.
