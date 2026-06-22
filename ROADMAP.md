# NOCTURNE desktop — autonomous build roadmap

The cron agent works this list **top-down, one item per run**. Pick the first
unchecked `[ ]` item, implement it, self-test (protocol below), and only if
ALL checks pass: check it off `[x]`, append a one-line note to the LOG, and
`git commit`. If a run can't finish an item cleanly, revert with
`git checkout -- .` and leave it unchecked. **Never break what works.**

## Self-test protocol (MUST pass before committing)
1. `python3 -c "import ast; ast.parse(open('backend.py').read())"` — backend parses.
2. `node -c main.js` and the renderer loads (no syntax error in src/*.js).
3. Boot test: launch backend with the ytm-tui venv on a TEST port
   (`NOCTURNE_PORT=8779 ~/ytm-tui/.venv/bin/python backend.py &`), wait ~6s,
   then `curl` the endpoints touched by the change and assert sane JSON.
   Kill the test backend by its own PID afterward (never `pkill -f` — it can
   signal the parent shell).
4. If the change adds an endpoint, prove it end-to-end with curl.
5. Keep diffs small and reversible. Don't edit `~/ytm-tui/ytm.py` (the shared
   core) — only this folder. Reuse ytm.py functions via the imported `N`.

## Features (in priority order)
- [x] **Visualizer**: backend streams the audio spectrum (reuse `N.SpectrumTap`)
      over `GET /api/spectrum` (or SSE); renderer draws a milkdrop/bars canvas
      behind the now-playing / in a `v` toggle. Theme-colored.
- [ ] **Like / unlike**: a heart on each row + in the player bar; `POST /api/like`
      → `yt.rate_song(vid, "LIKE"|"INDIFFERENT")`; reflect liked state from
      `get_watch_playlist` likeStatus. SoundCloud rows decline gracefully.
- [ ] **Queue / up-next panel**: a toggle showing `GET /api/queue` with the
      current track highlighted; click to jump; drag-free for now.
- [ ] **Theme switching**: expose the 7 ytm.py themes; `c` cycles; the GUI
      accent (`--accent`, gradients, lyrics) follows the active theme. Persist
      choice to a small `~/.config/nocturne-desktop/state.json`.
- [ ] **Add to queue / add to playlist**: right-click or hover button on a row
      → enqueue, or pick a playlist (`yt` library write ops already in ytm.py).
- [ ] **Repeat / shuffle**: transport toggles; backend honors them on EOF.
- [ ] **Now-playing full view**: a big-art "now playing" screen (art, title,
      progress, lyrics side-by-side) as an alternate to the list.
- [ ] **Window + volume persistence**: remember window size/pos and last volume
      in the state.json.
- [ ] **Polish pass**: loading skeletons, empty states, error toasts when the
      backend is unreachable, smoother art crossfades.

## LOG (newest last — one line per completed item)
- bootstrap: backend + Electron MVP (search/library/playlists/play/lyrics/align) — working.
- visualizer: GET /api/spectrum (reuses N.SpectrumTap, 0..1 levels); `v`/viz-btn toggles a theme-gradient bars canvas with attack/decay smoothing.
