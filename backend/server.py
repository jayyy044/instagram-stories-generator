"""Upload server for the stories app.

POST /api/batch          -> {"batch": "2026-07-24-1432"}   server-generated id
POST /api/upload?batch=&name=   raw image bytes in the body -> saves the file
GET  /api/batch/<id>     -> {"batch":..., "files":[{name,size}], "count":n}

One file per request, raw body, no multipart. stdlib has no multipart parser
since cgi was removed in 3.13, and per-file requests give the UI free progress.

Run: python backend/server.py     (vite proxies /api here, so no CORS needed)
"""

import io
import json
import os
import re
import shutil
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from PIL import Image, ImageOps

PORT = 8002
# ponytail: local disk under backend/. Swap UPLOADS for an S3/R2 client when
# uploads outlive one machine or the app runs anywhere but localhost.
UPLOADS = Path(__file__).parent / "uploads"

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
# Same three the swipe loop has always used: cut / edit / keep. None means undo.
# Redundancy is deliberately not here — that's a group judgement, not a per-photo
# one, which is what the duplicate key got wrong. See decisions D15.
VERDICTS = {"cut", "edit", "keep", None}
MAX_BYTES = 50 * 1024 * 1024  # a HEIC burst frame runs large; 50MB is slack
BATCH_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$")


def safe_name(raw):
    """Filename from an untrusted client. Returns None if it fails any check."""
    name = os.path.basename(raw.replace("\\", "/")).strip()
    if not name or name.startswith("."):
        return None
    if Path(name).suffix.lower() not in ALLOWED_EXT:
        return None
    # basename already strips traversal; this catches the leftovers
    if re.search(r'[\x00-\x1f<>:"|?*/]', name):
        return None
    return name[:120]


# Same trick as resolve.py: serving multi-MB originals to the browser is slow
# and exif_transpose is not optional — without it, portrait phone shots arrive
# sideways and every judgement made on them is made on a rotated photo.
_VIEW = {}


def view_bytes(path, w):
    key = (str(path), w, path.stat().st_mtime_ns)
    if key not in _VIEW:
        im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        im.thumbnail((w, w), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82)
        _VIEW[key] = buf.getvalue()
    return _VIEW[key]


def verdict_path(d):
    return d / "verdicts.json"


# One writer at a time. This server is threaded so the swipe page can preload
# the next photo while POSTing a verdict, and an unlocked read-modify-write
# loses votes: two threads both read {a}, each adds one key, last write wins.
_VERDICT_LOCK = threading.Lock()
# Separate lock: allocating a batch id must not wait on a verdict write.
_BATCH_LOCK = threading.Lock()


def load_verdicts(d):
    p = verdict_path(d)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        # Never silently return {} — that reads as "nothing judged yet" and the
        # next save overwrites a whole session. Keep the file, start clean.
        p.rename(p.with_suffix(f".corrupt-{datetime.now():%Y%m%d-%H%M%S}.json"))
        return {}
    except OSError:
        return {}


def save_verdicts(d, verdicts):
    # Unique temp name per writer: a shared "verdicts.json.tmp" lets two threads
    # interleave their writes and then promote the wreckage with replace().
    tmp = verdict_path(d).with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(verdicts, indent=1))
        tmp.replace(verdict_path(d))
    finally:
        tmp.unlink(missing_ok=True)


def batch_dir(batch, create=False):
    """Validated batch id -> its directory. None if the id is malformed."""
    if not batch or not BATCH_RE.match(batch):
        return None
    d = UPLOADS / batch
    if create:
        d.mkdir(parents=True, exist_ok=True)
    elif not d.is_dir():
        return None
    return d


class H(BaseHTTPRequestHandler):
    def json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path.startswith("/api/batch/"):
            d = batch_dir(u.path[len("/api/batch/"):])
            if not d:
                return self.json({"error": "unknown batch"}, 404)
            files = [{"name": f.name, "size": f.stat().st_size}
                     for f in sorted(d.iterdir())
                     if f.is_file() and f.suffix.lower() in ALLOWED_EXT]
            return self.json({"batch": d.name, "files": files, "count": len(files)})

        if u.path == "/api/verdicts":
            d = batch_dir(q.get("batch", [""])[0])
            if not d:
                return self.json({"error": "unknown batch"}, 404)
            return self.json({"batch": d.name, "verdicts": load_verdicts(d)})

        if u.path == "/api/photo":
            d = batch_dir(q.get("batch", [""])[0])
            name = safe_name(q.get("name", [""])[0])
            if not d or not name:
                return self.json({"error": "unknown photo"}, 404)
            path = d / name
            if not path.is_file():
                return self.json({"error": "unknown photo"}, 404)
            try:
                w = max(200, min(3000, int(q.get("w", ["1400"])[0])))
            except ValueError:
                w = 1400
            try:
                body = view_bytes(path, w)
            except Exception:
                # HEIC needs pillow-heif, which is blocked on this machine, so
                # the UI has to cope with a photo it cannot show. See D4.
                return self.json({"error": "cannot decode this image"}, 415)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            # A name inside a batch is immutable, so let the browser keep it.
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            return self.wfile.write(body)

        self.json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/api/batch":
            # The id is second-resolution, so two batches started in the same
            # second would collide and silently merge into one directory. Walk
            # forward to the first free id, under a lock so two threads can't
            # both claim it.
            with _BATCH_LOCK:
                t = datetime.now()
                for _ in range(120):
                    batch = t.strftime("%Y-%m-%d-%H%M%S")
                    if not (UPLOADS / batch).exists():
                        break
                    t += timedelta(seconds=1)
                else:
                    return self.json({"error": "could not allocate a batch id"}, 503)
                d = batch_dir(batch, create=True)
            # Intent is stated, never inferred — "lazy sunday", "night out".
            # learn.py needs it to tell stable taste from per-folder intent;
            # without it a hike teaches the profile that portraits get cut.
            intent = ""
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length:
                    intent = str(json.loads(self.rfile.read(length)).get("intent", ""))
            except (ValueError, json.JSONDecodeError, AttributeError):
                intent = ""
            (d / "meta.json").write_text(json.dumps(
                {"batch": batch, "intent": intent.strip()[:80] or "unstated",
                 "created": datetime.now().isoformat(timespec="seconds")}, indent=1))
            return self.json({"batch": batch})

        if u.path == "/api/verdict":
            d = batch_dir(q.get("batch", [""])[0])
            if not d:
                return self.json({"error": "unknown batch"}, 400)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.json({"error": "bad body"}, 400)

            name = safe_name(body.get("name", ""))
            verdict = body.get("verdict")
            if not name or not (d / name).is_file():
                return self.json({"error": "unknown photo"}, 400)
            if verdict not in VERDICTS:
                # Not sorted(VERDICTS) — the set holds None, and sorting mixed
                # types raises, which would crash the error path itself.
                return self.json({"error": "verdict must be cut, edit, keep or null"}, 400)

            # Read-modify-write has to be atomic as a whole, not just the write.
            try:
                with _VERDICT_LOCK:
                    verdicts = load_verdicts(d)
                    if verdict is None:
                        verdicts.pop(name, None)  # undo
                    else:
                        verdicts[name] = verdict
                    save_verdicts(d, verdicts)
                    count = len(verdicts)
            except OSError as e:
                # Always answer. An exception escaping here closes the socket
                # with no status line, and the client reads that as success.
                return self.json({"error": f"could not save: {e}"}, 500)
            return self.json({"name": name, "verdict": verdict, "count": count})

        if u.path != "/api/upload":
            return self.json({"error": "not found"}, 404)

        d = batch_dir(q.get("batch", [""])[0])
        if not d:
            return self.json({"error": "unknown batch"}, 400)

        name = safe_name(q.get("name", [""])[0])
        if not name:
            return self.json({"error": "bad filename or unsupported type"}, 400)

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.json({"error": "bad Content-Length"}, 400)
        if length <= 0:
            return self.json({"error": "empty body"}, 400)
        if length > MAX_BYTES:
            return self.json({"error": f"file over {MAX_BYTES // 1024 // 1024}MB"}, 413)

        # stream to a .part file so a dropped connection never leaves a
        # truncated image looking like a complete one
        part = d / (name + ".part")
        written = 0
        try:
            with open(part, "wb") as f:
                while written < length:
                    chunk = self.rfile.read(min(65536, length - written))
                    if not chunk:
                        raise IOError("client disconnected")
                    f.write(chunk)
                    written += len(chunk)
            shutil.move(str(part), str(d / name))
        except Exception as e:
            part.unlink(missing_ok=True)
            return self.json({"error": str(e)}, 400)

        self.json({"name": name, "size": written, "batch": d.name})

    def log_message(self, fmt, *a):
        pass  # the UI shows progress; per-request noise buries real errors


def demo():
    """Self-check on the two things that can actually hurt: path traversal
    and batch-id validation. Run: python backend/server.py --selftest"""
    assert safe_name("../../etc/passwd.jpg") == "passwd.jpg"
    assert safe_name("..\\..\\win.png") == "win.png"
    assert safe_name("photo.jpg") == "photo.jpg"
    assert safe_name("IMG_0042.HEIC") == "IMG_0042.HEIC"
    assert safe_name("resolve.py") is None
    assert safe_name("shell.jpg;rm -rf") is None      # bad ext after basename
    assert safe_name("") is None
    assert safe_name(".hidden.jpg") is None
    assert safe_name("a/b/c.png") == "c.png"
    assert batch_dir("../../secrets") is None
    assert batch_dir("2026-07-24") is None            # right shape, wrong length
    assert batch_dir("") is None
    assert BATCH_RE.match("2026-07-24-143205")

    # Verdicts round-trip, including undo, without touching a real batch.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        assert load_verdicts(d) == {}
        save_verdicts(d, {"a.jpg": "keep"})
        assert load_verdicts(d) == {"a.jpg": "keep"}
        v = load_verdicts(d)
        v.pop("a.jpg", None)
        save_verdicts(d, v)
        assert load_verdicts(d) == {}
        assert not verdict_path(d).with_suffix(".json.tmp").exists()
    # Concurrent writers must not lose a verdict or shred the file. Without the
    # lock this loses entries and occasionally leaves invalid JSON on disk.
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        names = [f"p{n:03d}.jpg" for n in range(60)]

        def writer(name):
            with _VERDICT_LOCK:
                v = load_verdicts(d)
                v[name] = "keep"
                save_verdicts(d, v)

        threads = [threading.Thread(target=writer, args=(n,)) for n in names]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        final = load_verdicts(d)
        assert len(final) == len(names), f"lost verdicts: {len(final)} of {len(names)}"
        assert not list(d.glob("*.tmp")), "left a temp file behind"

    assert "keep" in VERDICTS and None in VERDICTS and "duplicate" not in VERDICTS
    # The rejection path must not raise while building its own message.
    try:
        sorted(VERDICTS)
        raise AssertionError("expected sorting a None-bearing set to raise")
    except TypeError:
        pass
    print("selftest ok")


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        demo()
        sys.exit(0)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    print(f"\n  uploads -> {UPLOADS}")
    print(f"  http://127.0.0.1:{PORT}\n")
    # Threading: the swipe view preloads the next photo while showing the
    # current one, and a single-threaded server makes the second request wait.
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
