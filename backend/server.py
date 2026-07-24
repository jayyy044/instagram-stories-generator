"""Upload server for the stories app.

POST /api/batch          -> {"batch": "2026-07-24-1432"}   server-generated id
POST /api/upload?batch=&name=   raw image bytes in the body -> saves the file
GET  /api/batch/<id>     -> {"batch":..., "files":[{name,size}], "count":n}

One file per request, raw body, no multipart. stdlib has no multipart parser
since cgi was removed in 3.13, and per-file requests give the UI free progress.

Run: python backend/server.py     (vite proxies /api here, so no CORS needed)
"""

import json
import os
import re
import shutil
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8002
# ponytail: local disk under backend/. Swap UPLOADS for an S3/R2 client when
# uploads outlive one machine or the app runs anywhere but localhost.
UPLOADS = Path(__file__).parent / "uploads"

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
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
        if u.path.startswith("/api/batch/"):
            d = batch_dir(u.path[len("/api/batch/"):])
            if not d:
                return self.json({"error": "unknown batch"}, 404)
            files = [{"name": f.name, "size": f.stat().st_size}
                     for f in sorted(d.iterdir()) if f.is_file()]
            return self.json({"batch": d.name, "files": files, "count": len(files)})
        self.json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/api/batch":
            batch = datetime.now().strftime("%Y-%m-%d-%H%M%S")
            batch_dir(batch, create=True)
            return self.json({"batch": batch})

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
    print("selftest ok")


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        demo()
        sys.exit(0)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    print(f"\n  uploads -> {UPLOADS}")
    print(f"  http://127.0.0.1:{PORT}\n")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
