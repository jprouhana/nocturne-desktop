#!/usr/bin/env python3
"""NOCTURNE desktop backend — reuses the terminal app's core (ytm.py) and
exposes it over a tiny localhost JSON API the Electron front-end drives.

Everything hard (YouTube Music auth, mpv playback, yt-dlp, SoundCloud merge,
synced lyrics, AI force-alignment) is the SAME battle-tested code from the
TUI; this file just wires it to HTTP instead of a terminal.
"""
import importlib.util
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── load the terminal app as a library ──────────────────────────────────────
YTM_PATH = os.environ.get("NOCTURNE_YTM",
                          os.path.expanduser("~/ytm-tui/ytm.py"))
_spec = importlib.util.spec_from_file_location("nocturne_core", YTM_PATH)
N = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(N)
except SystemExit:
    pass

PORT = int(os.environ.get("NOCTURNE_PORT", "8770"))
QSTATE = os.path.expanduser("~/.config/nocturne-desktop/queue.json")


def _mk(d):
    return N.Track(d.get("video_id", ""), d.get("title", "?"),
                   d.get("artist", ""), d.get("album", ""),
                   d.get("duration", ""), d.get("thumb", ""), "", "",
                   d.get("video_type", ""))


# ── lyrics pipeline (mirrors ytm.py's App._get_lyrics, sans the TUI) ─────────
def _yt_lyrics_for(yt, vid):
    try:
        wp = yt.get_watch_playlist(videoId=vid, limit=1)
        bid = (wp or {}).get("lyrics")
        if not bid:
            return []
        data = yt.get_lyrics(bid)
    except Exception:
        return []
    lyr = (data or {}).get("lyrics")
    if not isinstance(lyr, str):
        return []
    return [(-1.0, ln.strip()) for ln in lyr.splitlines() if ln.strip()]


def _yt_lyrics(yt, track, lenient=False):
    lines = _yt_lyrics_for(yt, track.video_id)
    if lines:
        return lines
    my = N._lyr_secs(track.duration)
    q = N._lyr_clean(track.title)
    if not lenient:
        q += " " + N._lyr_clean(track.artist.split(",")[0])
    try:
        results = yt.search(q, limit=5)
    except Exception:
        return []
    best, best_s = None, 0.0
    mine = N._sync_tokens(track.title)
    for r in results:
        if r.get("resultType") != "song" or not r.get("videoId"):
            continue
        rs = r.get("duration_seconds") or 0
        if not lenient and my and rs and abs(rs - my) > 12:
            continue
        ra = ", ".join(a.get("name", "") for a in (r.get("artists") or []))
        if lenient:
            theirs = N._sync_tokens(r.get("title", "") + " " + ra)
            s = (len(mine & theirs) / len(mine | theirs)) if mine and theirs else 0.0
        else:
            s = N._sync_score(track.title, track.artist, r.get("title", ""), ra)
        if s > best_s:
            best, best_s = r["videoId"], s
    if best and best_s >= (0.4 if lenient else 0.5) and best != track.video_id:
        return _yt_lyrics_for(yt, best)
    return []


class App:
    def __init__(self):
        self.yt = None
        try:
            self.yt = N.make_ytmusic()
        except Exception as e:
            print("yt auth failed:", e, file=sys.stderr)
        self.player = N.Player(self._on_eof)
        self.queue = []          # list[Track]
        self.qpos = -1
        self.now = None
        self.repeat = 0          # 0 off · 1 all · 2 one
        self.shuffle = False
        self.liked = {}          # video_id -> bool
        self._lyrics = {}        # vid -> [(sec,line)] | [] | "..."
        self._aligning = None
        self._url_cache = {}
        self.spectrum = None     # live FFT off the default sink monitor
        try:
            self.spectrum = N.SpectrumTap()
            self.spectrum.start()
        except Exception as e:
            print("spectrum tap failed:", e, file=sys.stderr)
        self._restore_queue()

    # ── queue persistence ─────────────────────────────────────────────────
    def _t2d(self, t):
        return {"video_id": t.video_id, "title": t.title, "artist": t.artist,
                "album": t.album, "duration": t.duration, "thumb": t.thumb,
                "video_type": getattr(t, "video_type", "")}

    def _save_queue(self):
        try:
            os.makedirs(os.path.dirname(QSTATE), exist_ok=True)
            with open(QSTATE, "w") as f:
                json.dump({"qpos": self.qpos,
                           "queue": [self._t2d(t) for t in self.queue]}, f)
        except Exception:
            pass

    def _restore_queue(self):
        try:
            with open(QSTATE) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        self.queue = [_mk(d) for d in data.get("queue", [])]
        self.qpos = data.get("qpos", -1)
        if 0 <= self.qpos < len(self.queue):
            self.now = self.queue[self.qpos]
            self.play_at(self.qpos)                # resume the last track…
            self.player.cmd("set_property", "pause", True)   # …but paused

    def queue_remove(self, idx):
        if not (0 <= idx < len(self.queue)):
            return
        del self.queue[idx]
        if idx < self.qpos:
            self.qpos -= 1
        elif idx == self.qpos:
            if self.qpos < len(self.queue):
                self.play_at(self.qpos)
            elif self.queue:
                self.play_at(len(self.queue) - 1)
            else:
                self.qpos = -1
                self.now = None
                self.player.stop()
        self._save_queue()

    def queue_move(self, idx, to):
        n = len(self.queue)
        if not (0 <= idx < n and 0 <= to < n) or idx == to:
            return
        t = self.queue.pop(idx)
        self.queue.insert(to, t)
        if idx == self.qpos:
            self.qpos = to
        elif idx < self.qpos <= to:
            self.qpos -= 1
        elif to <= self.qpos < idx:
            self.qpos += 1
        self._save_queue()

    # ── playback ─────────────────────────────────────────────────────────
    def _on_eof(self):
        if self.repeat == 2:                       # loop one
            self.player.seek_to(0)
            self.player.cmd("set_property", "pause", False)
        elif self.qpos + 1 < len(self.queue):
            self.play_at(self.qpos + 1)
        elif self.repeat == 1 and self.queue:      # repeat all → wrap
            self.play_at(0)

    def play_at(self, idx):
        if not (0 <= idx < len(self.queue)):
            return
        self.qpos = idx
        self.now = self.queue[idx]
        t = self.now
        if t.source == "sc":
            self.player.play_video(t.video_id)
            threading.Thread(target=self._sc_resolve, args=(t,), daemon=True).start()
        else:
            self.player.play_video(t.video_id)
        threading.Thread(target=self._fetch_liked, args=(t,), daemon=True).start()
        self._save_queue()

    def _fetch_liked(self, t):
        if t.source == "sc" or not self.yt:
            return
        try:
            data = self.yt.get_watch_playlist(videoId=t.video_id, limit=1)
            tr = (data.get("tracks") or [{}])[0]
            if self.now is t:
                self.liked[t.video_id] = tr.get("likeStatus") == "LIKE"
        except Exception:
            pass

    def toggle_like(self):
        t = self.now
        if not t or t.source == "sc" or not self.yt:
            return
        liked = not self.liked.get(t.video_id, False)
        self.liked[t.video_id] = liked
        try:
            self.yt.rate_song(t.video_id, "LIKE" if liked else "INDIFFERENT")
        except Exception:
            self.liked[t.video_id] = not liked

    def do_shuffle(self):
        import random
        if len(self.queue) <= 2:
            return
        cur = self.now
        rest = [t for i, t in enumerate(self.queue) if i != self.qpos]
        random.shuffle(rest)
        self.queue = ([cur] if cur else []) + rest
        self.qpos = 0
        self.shuffle = True

    def add_to_playlist(self, video_id, playlist_id):
        if not self.yt:
            return False
        try:
            self.yt.add_playlist_items(playlist_id, [video_id], duplicates=True)
            return True
        except Exception:
            return False

    def _sc_resolve(self, t):
        try:
            url = N.sc_resolve_fast(t)
            if url and self.now is t:
                self.player.play_video(t.video_id, direct=url)
        except Exception:
            pass

    def set_queue(self, tracks, index=0):
        self.queue = tracks
        self.shuffle = False
        if tracks:
            self.play_at(max(0, min(index, len(tracks) - 1)))
        self._save_queue()

    def enqueue(self, tracks):
        self.queue.extend(tracks)
        if self.qpos < 0 and self.queue:
            self.play_at(0)
        self._save_queue()

    def next(self):
        self._on_eof()

    def prev(self):
        pos = self.player.props.get("time-pos") or 0
        if pos > 3 or self.qpos <= 0:
            self.player.seek_to(0)
        else:
            self.play_at(self.qpos - 1)

    # ── lyrics ───────────────────────────────────────────────────────────
    def get_lyrics(self, track):
        vid = track.video_id
        cur = self._lyrics.get(vid)
        if cur is not None:
            return None if cur == "..." else cur
        self._lyrics[vid] = "..."

        def go():
            lines = []
            try:
                path = N.lyrics_cache_path(vid)
                try:
                    with open(path, encoding="utf-8") as f:
                        cached = f.read()
                    if cached.strip() == "\x00":
                        self._lyrics[vid] = []
                        return
                    lines = N.parse_lrc(cached)
                    self._lyrics[vid] = lines
                    if lines and lines[0][0] >= 0:
                        return
                    cached_plain = True
                except OSError:
                    cached_plain = False
                if not lines and self.yt and track.source == "yt":
                    lines = _yt_lyrics(self.yt, track)
                    if lines:
                        self._lyrics[vid] = lines
                if (lines or cached_plain) and track.video_type != "MUSIC_VIDEO_TYPE_UGC":
                    synced = N.lrclib_synced(track, timeout=6)
                    if synced:
                        lines = synced
                        self._lyrics[vid] = synced
                elif not lines:
                    text, reached = N.lrclib_text(track)
                    lines = N.parse_lrc(text) if text else []
                    if not (text or reached):
                        self._lyrics[vid] = lines
                        return
                try:
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(N.lines_to_lrc(lines) if lines else "\x00")
                except OSError:
                    pass
            except Exception:
                lines = []
            self._lyrics[vid] = lines
        threading.Thread(target=go, daemon=True).start()
        return None

    def align(self, track):
        import subprocess
        import tempfile
        if track.source != "yt" or self._aligning:
            return
        vid = track.video_id
        self._aligning = vid

        def go():
            tf = None
            try:
                cur = self._lyrics.get(vid)
                if not isinstance(cur, list) or len(cur) < 2:
                    cur = _yt_lyrics(self.yt, track, lenient=True) if self.yt else []
                if not isinstance(cur, list) or len(cur) < 2:
                    return
                text = "\n".join(t for _, t in cur if t.strip())
                tf = tempfile.NamedTemporaryFile("w", suffix=".txt",
                                                 delete=False, encoding="utf-8")
                tf.write(text)
                tf.close()
                out = N.lyrics_cache_path(vid)
                r = subprocess.run(["nocturne-align", "--audio", vid,
                                    "--lyrics-file", tf.name, "--out", out],
                                   capture_output=True, text=True, timeout=420)
                if r.returncode == 0:
                    with open(out, encoding="utf-8") as f:
                        aligned = N.parse_lrc(f.read())
                    if aligned:
                        self._lyrics[vid] = aligned
            except Exception:
                pass
            finally:
                if tf:
                    try:
                        os.unlink(tf.name)
                    except OSError:
                        pass
                self._aligning = None
        threading.Thread(target=go, daemon=True).start()


APP = App()


# ── serialization ────────────────────────────────────────────────────────────
def track_json(t):
    if not t:
        return None
    return {"video_id": t.video_id, "title": t.title, "artist": t.artist,
            "album": t.album, "duration": t.duration, "thumb": t.thumb,
            "source": t.source, "video_type": getattr(t, "video_type", "")}


# ── HTTP ─────────────────────────────────────────────────────────────────────
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except ValueError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = u.path
        try:
            if p == "/api/state":
                pl = APP.player
                self._send({
                    "now": track_json(APP.now),
                    "pos": pl.props.get("time-pos") or 0,
                    "dur": pl.props.get("duration") or 0,
                    "paused": bool(pl.props.get("pause")),
                    "volume": pl.props.get("volume") or 0,
                    "loading": pl.loading,
                    "qpos": APP.qpos, "queue_len": len(APP.queue),
                    "aligning": bool(APP._aligning and APP.now
                                     and APP._aligning == APP.now.video_id),
                    "repeat": APP.repeat, "shuffle": APP.shuffle,
                    "liked": bool(APP.now and APP.liked.get(APP.now.video_id)),
                    "likeable": bool(APP.now and APP.now.source == "yt"),
                })
            elif p == "/api/themes":
                self._send([{"name": t[0], "red": list(t[1]),
                             "orange": list(t[2]), "pink": list(t[3])}
                            for t in N.THEMES])
            elif p == "/api/queue":
                self._send([track_json(t) for t in APP.queue])
            elif p == "/api/spectrum":
                n = 48
                try:
                    n = max(8, min(128, int((q.get("n") or ["48"])[0])))
                except ValueError:
                    pass
                if APP.spectrum:
                    self._send({"levels": APP.spectrum.levels(n),
                                "producing": bool(APP.spectrum.producing)})
                else:
                    self._send({"levels": [0.0] * n, "producing": False})
            elif p == "/api/search":
                query = (q.get("q") or [""])[0]
                out = []
                if APP.yt and query:
                    try:
                        for it in APP.yt.search(query, limit=25):
                            if it.get("videoId") and it.get("resultType") in ("song", "video"):
                                out.append(track_json(N.Track.from_item(it)))
                    except Exception:
                        pass
                self._send(out)
            elif p == "/api/sc_search":
                query = (q.get("q") or [""])[0]
                out = []
                try:
                    for t in N.sc_search(query, 12):
                        out.append(track_json(t))
                except Exception:
                    pass
                self._send(out)
            elif p == "/api/library":
                out = []
                if APP.yt:
                    try:
                        data = APP.yt.get_liked_songs(limit=400)
                        for it in (data or {}).get("tracks", []):
                            if it.get("videoId"):
                                out.append(track_json(N.Track.from_item(it)))
                    except Exception:
                        pass
                self._send(out)
            elif p == "/api/playlists":
                out = []
                if APP.yt:
                    try:
                        for pl in APP.yt.get_library_playlists(limit=50):
                            out.append({"id": pl.get("playlistId"),
                                        "title": pl.get("title"),
                                        "count": pl.get("count")})
                    except Exception:
                        pass
                self._send(out)
            elif p == "/api/playlist":
                pid = (q.get("id") or [""])[0]
                out = []
                if APP.yt and pid:
                    try:
                        data = APP.yt.get_playlist(pid, limit=300)
                        for it in (data or {}).get("tracks", []):
                            if it.get("videoId"):
                                out.append(track_json(N.Track.from_item(it)))
                    except Exception:
                        pass
                self._send(out)
            elif p == "/api/lyrics":
                vid = (q.get("video_id") or [""])[0]
                t = APP.now if (APP.now and APP.now.video_id == vid) else None
                if not t:
                    self._send({"state": "none"})
                    return
                lines = APP.get_lyrics(t)
                if lines is None:
                    self._send({"state": "loading"})
                elif not lines:
                    self._send({"state": "empty"})
                else:
                    self._send({"state": "ok",
                                "synced": lines[0][0] >= 0,
                                "lines": [[round(s, 2), txt] for s, txt in lines]})
            else:
                self._send({"error": "not found"}, 404)
        except Exception as e:
            self._send({"error": str(e)}, 500)

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        b = self._body()
        try:
            if p == "/api/play":
                tracks = [_mk(t) for t in b.get("tracks", [])]
                if tracks:
                    APP.set_queue(tracks, b.get("index", 0))
                elif b.get("video_id"):
                    APP.set_queue([_mk(b)], 0)
                self._send({"ok": True})
            elif p == "/api/enqueue":
                APP.enqueue([_mk(t) for t in b.get("tracks", [])])
                self._send({"ok": True})
            elif p == "/api/toggle":
                APP.player.toggle_pause()
                self._send({"ok": True})
            elif p == "/api/next":
                APP.next()
                self._send({"ok": True})
            elif p == "/api/prev":
                APP.prev()
                self._send({"ok": True})
            elif p == "/api/seek":
                APP.player.seek_to(float(b.get("pos", 0)))
                self._send({"ok": True})
            elif p == "/api/volume":
                v = float(b.get("volume", 70))
                APP.player.cmd("set_property", "volume", v)
                APP.player.props["volume"] = v
                self._send({"ok": True})
            elif p == "/api/align":
                if APP.now:
                    APP.align(APP.now)
                self._send({"ok": True})
            elif p == "/api/like":
                APP.toggle_like()
                self._send({"liked": bool(APP.now and APP.liked.get(APP.now.video_id))})
            elif p == "/api/repeat":
                APP.repeat = int(b.get("mode", (APP.repeat + 1) % 3)) % 3
                self._send({"repeat": APP.repeat})
            elif p == "/api/shuffle":
                APP.do_shuffle()
                self._send({"ok": True})
            elif p == "/api/queue_jump":
                APP.play_at(int(b.get("index", 0)))
                self._send({"ok": True})
            elif p == "/api/queue_remove":
                APP.queue_remove(int(b.get("index", -1)))
                self._send({"ok": True})
            elif p == "/api/queue_move":
                APP.queue_move(int(b.get("index", -1)), int(b.get("to", -1)))
                self._send({"ok": True})
            elif p == "/api/add_to_playlist":
                ok = APP.add_to_playlist(b.get("video_id", ""), b.get("playlist_id", ""))
                self._send({"ok": ok})
            else:
                self._send({"error": "not found"}, 404)
        except Exception as e:
            self._send({"error": str(e)}, 500)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"NOCTURNE backend on http://127.0.0.1:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            APP.player.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
