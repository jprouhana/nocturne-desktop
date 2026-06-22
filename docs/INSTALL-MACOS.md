# NOCTURNE desktop — macOS install

Works on Apple Silicon and Intel. You install the **core** (`ytm.py` + Python
deps), **mpv**, and **Node** — all via Homebrew.

## 1. Prerequisites
```sh
# Homebrew: https://brew.sh
brew install python node mpv ffmpeg git
```
Verify: `python3 --version`, `node --version`, `mpv --version`.

## 2. The core (ytm.py + sign-in)
```sh
git clone https://github.com/jprouhana/nocturne ~/ytm-tui
cd ~/ytm-tui
python3 -m venv .venv
./.venv/bin/pip install --upgrade ytmusicapi pillow numpy yt-dlp
# sign in to YouTube Music (browser-cookie wizard — any browser)
./.venv/bin/python ytm.py --login
```
Auth is written to `~/.config/ytm-tui/` (local only, `chmod 600`).
SoundCloud is optional: `./.venv/bin/python ytm.py --sc-login`.

## 3. The desktop app
```sh
git clone https://github.com/jprouhana/nocturne-desktop ~/nocturne-desktop
cd ~/nocturne-desktop
npm install
npm start
```
`main.js` auto-detects `~/ytm-tui/.venv/bin/python`. If your core lives
elsewhere, override before `npm start`:
```sh
NOCTURNE_PY=/path/to/.venv/bin/python NOCTURNE_YTM=/path/to/ytm.py npm start
```

## Visualizer audio (loopback)
macOS can't tap an app's output directly, so the FFT bars need a virtual
loopback device:
```sh
brew install blackhole-2ch
```
Then in **System Settings → Sound**, create a **Multi-Output Device**
(your speakers + BlackHole) and select it as output — you hear audio *and* the
spectrum tap can read it. Without this, playback works fine but the bars stay
flat. (The `SpectrumTap` in `ytm.py` already sniffs an avfoundation loopback.)

## Notes / limits
- **`⟁ AI-align`** works on macOS if you have a local faster-whisper install and
  the `nocturne-align` helper; it runs on CPU (slower) without a GPU. Optional —
  every other feature works without it.
- First launch of an unsigned Electron app may need **System Settings → Privacy
  & Security → Open Anyway**, or run from Terminal with `npm start`.

## Troubleshooting
- **"backend unreachable"** → run the backend by hand to see the error:
  `cd ~/nocturne-desktop && ~/ytm-tui/.venv/bin/python backend.py`
- **No sound / playback stalls** → `./.venv/bin/pip install -U yt-dlp`.
- **Bars flat** → set up the BlackHole Multi-Output device (above).
