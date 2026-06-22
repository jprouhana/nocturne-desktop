# NOCTURNE — desktop

A windowed (Electron) copy of the terminal NOCTURNE. The GUI is a thin
front-end; all the real work (YouTube Music auth, mpv playback, yt-dlp,
SoundCloud, synced lyrics, AI force-alignment) is the **same `ytm.py` core**
running as a local backend (`backend.py`).

## run
```sh
nocturne-app          # or: cd ~/nocturne-desktop && npm start
```
Reuses the terminal app's sign-in and its `.venv` automatically. No separate
login. `backend.py` is spawned and killed with the window.

## keys
- `space` play/pause · `shift+←/→` prev/next · `L` lyrics
- double-click a track to play · `⟁` AI-aligns lyrics to the exact audio

## layout
- `main.js` — Electron shell, spawns the Python backend
- `backend.py` — imports `~/ytm-tui/ytm.py`, serves a localhost JSON API
- `src/` — the GUI (index.html / style.css / renderer.js)
