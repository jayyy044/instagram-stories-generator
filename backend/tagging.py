"""Describe a batch's photos so the learning stage has something to reason over.

Moved into the backend from probe1_tag.py: tagging is part of what the system
does, not a script the user runs in a terminal.

Writes manifest.json into the batch directory. Incremental — photos already in
the manifest are skipped, so re-running after adding more costs only the new
ones. Uses stdlib urllib, not the SDK: the SDK's compiled `jiter` is blocked by
this machine's Application Control policy (D4).
"""

import base64
import io
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

API_URL = "https://api.anthropic.com/v1/messages"
# Deliberately the same model probe1_tag.py used for the 178 already-tagged
# photos. Tags are free-invented prose, so a different model writes a different
# vocabulary — and learn.py pools tags across folders, where that drift would
# look like taste drift. Change it only by re-tagging every folder together.
MODEL = "claude-opus-4-8"
CHUNK = 8
LONG_EDGE = 512  # plenty for vibe; we are not reading text off these
HERE = Path(__file__).parent

PHOTO = {
    "type": "object",
    "properties": {
        "file": {"type": "string"},
        "subject": {"type": "string"},
        "light": {"type": "string"},
        "palette": {"type": "array", "items": {"type": "string"}},
        "setting": {"type": "string"},
        "time_read": {"type": "string"},
        "motion": {"type": "string"},
        "density": {"type": "string"},
        "vibe_tags": {"type": "array", "items": {"type": "string"}},
        "beat": {"type": "string"},
        "solo_worthy": {"type": "number"},
        "why_solo": {"type": "string"},
    },
    "required": ["file", "subject", "light", "palette", "density", "setting",
                 "time_read", "motion", "vibe_tags", "beat", "solo_worthy", "why_solo"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {"photos": {"type": "array", "items": PHOTO}},
    "required": ["photos"],
    "additionalProperties": False,
}

PROMPT = """Read these photos the way someone deciding what goes in an Instagram story reads them.

Not "what objects are present" - what the photo FEELS like, and what it would be good for.

For each image, in the order given:

- subject: what's actually happening. Be specific. "two people mid-laugh, one holding a
  drink up" not "people at a party".
- light: the quality and source. Hard flash. Low warm sun. Overhead fluorescent. Overcast flat.
- palette: 3 dominant hex colors.
- setting: where this is. indoor/outdoor and what kind of place.
- time_read: what time of day it reads as, from the light, not from metadata.
- motion: still / slight / blurred-motion / camera-shake.
- density: how full the frame is. empty / sparse / busy / packed.
- vibe_tags: 2-3 aesthetic labels. Invent them - don't pick from a list. Labels a person
  would actually use: "neon-night-out", "soft-domestic-morning", "grimy-basement-show".
- beat: where this sits in the arc of the event. arrival / build / peak / wind-down / aftermath.
  Judge from energy, light, crowd, and how composed people look - not from filename order.
- solo_worthy: 0.0-1.0. Does this photo deserve a full frame to itself, or does it only
  work grouped with others? SPREAD THESE SCORES. If everything lands at 0.5 you are hedging,
  and a hedged score is useless to me. Some photos are genuinely a 0.2.
- why_solo: one clause defending that number.

Use the exact filename given in the text block before each image."""


def api_key():
    """CLAUDEAPIKEY, without loading the rest of a secrets file into memory.

    Order: ANTHROPIC_API_KEY in the environment, else the file named by
    CLAUDE_ENV_FILE in backend/.env.local. That indirection keeps the path to
    the real secrets file out of this repo, which is public.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]

    local = HERE / ".env.local"
    if not local.exists():
        raise RuntimeError("no ANTHROPIC_API_KEY and no backend/.env.local")

    path = None
    for line in local.read_text().splitlines():
        if line.strip().startswith("CLAUDE_ENV_FILE="):
            path = Path(line.split("=", 1)[1].strip())
    if not path or not path.exists():
        raise RuntimeError("CLAUDE_ENV_FILE missing or points nowhere")

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"\s*CLAUDEAPIKEY\s*=\s*(.+)", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError("CLAUDEAPIKEY not found in the env file")


def encode(path):
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    img.thumbnail((LONG_EDGE, LONG_EDGE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return base64.standard_b64encode(buf.getvalue()).decode()


def _post(body, key):
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Never echo the key, and keep the body short — this reaches the UI.
        raise RuntimeError(f"API {e.code}: {e.read().decode()[:300]}") from None


def tag_chunk(paths, key):
    content = [{"type": "text", "text": PROMPT}]
    for p in paths:
        content.append({"type": "text", "text": f"filename: {p.name}"})
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg", "data": encode(p)}})
    out = _post({
        "model": MODEL,
        "max_tokens": 16000,
        # output_config.format — the older top-level output_format is deprecated
        # and now 400s ("use 'output_config.format' instead").
        "messages": [{"role": "user", "content": content}],
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
    }, key)
    text = "".join(b.get("text", "") for b in out.get("content", []))
    return json.loads(text)["photos"], out.get("usage", {})


def tag_dir(d, exts, on_progress=None):
    """Tag every untagged photo in `d`. Returns {tagged, skipped, total}."""
    manifest_path = d / "manifest.json"
    try:
        existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    except (json.JSONDecodeError, OSError):
        existing = []
    done = {p["file"] for p in existing}

    photos = sorted(p for p in d.iterdir()
                    if p.is_file() and p.suffix.lower() in exts)
    todo = [p for p in photos if p.name not in done]
    if not todo:
        return {"tagged": 0, "skipped": len(photos), "total": len(photos)}

    key = api_key()
    tagged = list(existing)
    for i in range(0, len(todo), CHUNK):
        chunk = todo[i:i + CHUNK]
        got, _ = tag_chunk(chunk, key)
        # Trust the filenames we sent, not the ones echoed back.
        by_name = {g.get("file"): g for g in got}
        for p in chunk:
            g = by_name.get(p.name)
            if g:
                g["file"] = p.name
                tagged.append(g)
        # Written every chunk: a failure at photo 90 must not discard 89.
        tmp = manifest_path.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(tagged, indent=1))
        tmp.replace(manifest_path)
        if on_progress:
            on_progress(min(i + CHUNK, len(todo)), len(todo))

    return {"tagged": len(tagged) - len(existing),
            "skipped": len(photos) - len(todo), "total": len(photos)}


def demo():
    """python backend/tagging.py --selftest — checks everything but the API."""
    assert api_key(), "no key resolved"
    assert SCHEMA["properties"]["photos"]["items"]["required"], "schema lost its fields"
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        d = Path(t)
        # An empty dir must be a no-op, not an API call.
        assert tag_dir(d, {".jpg"}) == {"tagged": 0, "skipped": 0, "total": 0}
        # A fully-tagged dir must also skip without calling out.
        (d / "a.jpg").write_bytes(b"not really a jpeg")
        (d / "manifest.json").write_text(json.dumps([{"file": "a.jpg"}]))
        assert tag_dir(d, {".jpg"}) == {"tagged": 0, "skipped": 1, "total": 1}
    print("tagging selftest ok")


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        demo()
    elif len(sys.argv) > 1:
        print(tag_dir(Path(sys.argv[1]), {".jpg", ".jpeg", ".png", ".webp"},
                      lambda n, t: print(f"  {n}/{t}", flush=True)))
    else:
        print(__doc__)
