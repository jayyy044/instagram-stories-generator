"""Derive a taste profile from your own labels, and only keep it if it helps.

Moved into the backend from learn.py: this is what the system does, not a
script to run in a terminal.

Method, unchanged from the original:
  1. Pool every folder that has labels. Split train/test WITHIN each folder so
     the held-out set is never dominated by one folder.
  2. Derive selection rules from TRAIN only.
  3. Classify the held-out TEST photos twice — once with no rules (baseline),
     once with the derived rules — and compare.

The comparison is the point. Rules that only fit the training half are worthless,
and without the held-out score there is no way to tell the difference.

New here: the RATCHET. A derived profile replaces the current one only if it
beats it on held-out photos. That is what makes this improve over time instead
of drifting — see decisions D13/D14.
"""

import json
import re
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import tagging

HERE = Path(__file__).parent
PROFILE_DIR = HERE / "profile"
PROFILE_MD = PROFILE_DIR / "taste-profile.md"
HISTORY = PROFILE_DIR / "history.json"

# Tagging deliberately pins the old model for vocabulary consistency; reasoning
# does not have that constraint. The model IS recorded per run, because a score
# produced by a different scorer is not comparable and the ratchet compares.
MODEL = "claude-opus-5"

# Your swipe vocab -> the 3-way this is scored on.
MINE = {"keep": "keep", "cut": "cut", "edit": "edit", "unsure": "edit"}

VSCHEMA = {
    "type": "object",
    "properties": {"photos": {"type": "array", "items": {
        "type": "object",
        "properties": {"file": {"type": "string"},
                       "verdict": {"type": "string", "enum": ["keep", "edit", "cut"]}},
        "required": ["file", "verdict"],
        "additionalProperties": False,
    }}},
    "required": ["photos"],
    "additionalProperties": False,
}


def _read(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default
    except (json.JSONDecodeError, OSError):
        return default


def _post(body, key):
    req = urllib.request.Request(
        tagging.API_URL,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-api-key": key,
                 "anthropic-version": "2023-06-01"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API {e.code}: {e.read().decode()[:300]}") from None


def _text(resp):
    return "".join(b.get("text", "") for b in resp.get("content", [])
                   if b.get("type") == "text").strip()


def sources(uploads):
    """Every batch that has labels AND tags, pooled. D14 rule 1: the profile is
    always re-derived from the whole pool, never patched folder by folder —
    patching drifts and cannot be audited."""
    found = []
    for d in sorted(p for p in uploads.glob("*") if p.is_dir()):
        raw = _read(d / "verdicts.json", {})
        labels = {k: MINE[v] for k, v in raw.items() if v in MINE}
        if not labels:
            continue
        tags = {p["file"]: p for p in _read(d / "manifest.json", [])}
        meta = _read(d / "meta.json", {})
        found.append({
            "batch": d.name,
            "intent": meta.get("intent", "unstated"),
            "labels": labels,
            "tags": {k: v for k, v in tags.items() if k in labels},
            "untagged": sorted(k for k in labels if k not in tags),
        })
    return found


def derive(train, key):
    """train = [(photo_tags, verdict), ...] -> selection rules in prose."""
    n = {v: sum(1 for _, x in train if x == v) for v in ("keep", "cut", "edit")}
    body = "\n".join(json.dumps({
        "verdict": v,
        "subject": p.get("subject", ""),
        "light": p.get("light", ""),
        "time": p.get("time_read", ""),
        "solo_worthy": p.get("solo_worthy"),
        "motion": p.get("motion", ""),
        "intent": p.get("_intent", "unstated"),
    }) for p, v in train)

    prompt = f"""Below are one person's real keep / cut / edit decisions on their
own photos. `edit` means "worth it but needs editing first".

They kept {n['keep']}, cut {n['cut']}, marked {n['edit']} for editing. Learn their
actual bar rather than assuming a generous one.

Each decision carries the INTENT of the folder it came from (e.g. "hike",
"night out"). This matters: a rule that only holds within one intent is not
taste, it is that day's circumstances. If every folder shares one intent, say so
plainly rather than inventing rules you cannot support.

Your job: write the SELECTION RULES that explain these decisions, so another
pass can reproduce this person's taste on photos it has not seen. Study what
they cut that a generous editor would keep, and what they kept that a strict
editor would cut — the boundaries are where the taste lives.

Write it as a tight briefing a fresh reviewer could follow. Cover:
- Overall bar: how strict, roughly what fraction survives.
- What gets CUT: the specific patterns (subject, light, redundancy, weakness).
- What survives as KEEP despite being unremarkable — their soft spots.
- What gets EDIT rather than keep or cut.
- Any signal that predicts their verdict.
- Which rules you believe are STABLE TASTE and which are tied to one intent.

Be specific and short. Rules a reviewer applies, not observations. No preamble.

Decisions:
{body}"""

    return _text(_post({
        "model": MODEL, "max_tokens": 4000,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "high"},
        "messages": [{"role": "user", "content": prompt}],
    }, key))


def classify(photos, profile, key):
    guide = ""
    if profile:
        guide = ("\n\n## How THIS person selects — learned from their own labels. "
                 "Apply it; it overrides any generic instinct.\n\n" + profile + "\n")

    rows = [{k: p.get(k) for k in
             ("file", "subject", "light", "time_read", "motion", "solo_worthy")}
            for p in photos]

    prompt = f"""Classify each photo keep / edit / cut. `edit` = worth it but needs
editing first. `cut` = not worth posting (blurry, dull, redundant, weak).

Default to the selection bar described below, not to generosity.{guide}

Return a verdict for every file, using the exact filename.

Photos:
{json.dumps(rows, indent=1)}"""

    resp = _post({
        "model": MODEL, "max_tokens": 16000,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "high",
                          "format": {"type": "json_schema", "schema": VSCHEMA}},
        "messages": [{"role": "user", "content": prompt}],
    }, key)
    return {p["file"]: p["verdict"] for p in json.loads(_text(resp))["photos"]}


def current():
    """The profile in force, plus its recorded held-out score."""
    hist = _read(HISTORY, [])
    kept = [h for h in hist if h.get("kept")]
    return {
        "profile": PROFILE_MD.read_text(encoding="utf-8") if PROFILE_MD.exists() else None,
        "score": kept[-1]["with_rules"] if kept else None,
        "runs": len(hist),
        "history": hist[-10:],
    }


def run(uploads, on_progress=None):
    """Derive, score against held-out photos, and keep only if it beat the
    profile currently in force. Returns the run record."""
    def say(msg):
        if on_progress:
            on_progress(msg)

    srcs = sources(uploads)
    if not srcs:
        raise RuntimeError("no labelled batches yet — swipe one first")

    untagged = [s["batch"] for s in srcs if s["untagged"]]
    if untagged:
        raise RuntimeError(f"tag these batches first: {', '.join(untagged)}")

    # Split within each batch so the held-out set is never one folder's photos.
    train, test, tags, truth = [], [], {}, {}
    for s in srcs:
        for p in s["tags"].values():
            p["_intent"] = s["intent"]
        files = [f for f in sorted(s["labels"]) if f in s["tags"]]
        tags.update(s["tags"])
        truth.update({f: s["labels"][f] for f in files})
        test += [f for i, f in enumerate(files) if i % 3 == 0]
        train += [f for i, f in enumerate(files) if i % 3 != 0]

    intents = sorted({s["intent"] for s in srcs})
    if len(train) < 10 or len(test) < 5:
        raise RuntimeError(
            f"not enough labelled+tagged photos to split honestly "
            f"({len(train)} train / {len(test)} test)")

    key = tagging.api_key()
    scored = lambda pred: (sum(1 for f in test if pred.get(f) == truth[f]), len(test))

    say(f"scoring {len(test)} held-out photos with no rules")
    base_ok, n = scored(classify([tags[f] for f in test], None, key))

    say(f"deriving rules from {len(train)} photos")
    profile = derive([(tags[f], truth[f]) for f in train], key)

    say("scoring the same photos with the derived rules")
    new_ok, _ = scored(classify([tags[f] for f in test], profile, key))

    prev = current()
    beat_baseline = new_ok > base_ok
    # Only replace the profile in force if it also beats that profile's own
    # recorded score. Without this the thing drifts instead of improving.
    beat_current = prev["score"] is None or new_ok >= prev["score"]
    kept = beat_baseline and beat_current

    record = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "model": MODEL,
        "batches": [s["batch"] for s in srcs],
        "intents": intents,
        "train": len(train), "test": n,
        "baseline": base_ok, "with_rules": new_ok,
        "delta_points": round((new_ok - base_ok) / n * 100) if n else 0,
        "kept": kept,
        "single_intent": len(intents) < 2,
    }

    if kept:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        PROFILE_MD.write_text(profile, encoding="utf-8")
        say(f"kept: {new_ok}/{n} vs {base_ok}/{n} baseline")
    else:
        say(f"discarded: {new_ok}/{n} did not beat "
            f"{prev['score'] if prev['score'] is not None else base_ok}/{n}")

    hist = _read(HISTORY, [])
    hist.append(record)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = HISTORY.with_suffix(".tmp")
    tmp.write_text(json.dumps(hist, indent=1), encoding="utf-8")
    tmp.replace(HISTORY)
    return record


def demo():
    """python backend/learning.py --selftest — everything but the API calls."""
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        up = Path(t)
        assert sources(up) == []

        b = up / "2026-01-01-000000"
        b.mkdir()
        (b / "verdicts.json").write_text(json.dumps({"a.jpg": "keep", "b.jpg": "duplicate"}), encoding="utf-8")
        (b / "manifest.json").write_text(json.dumps([{"file": "a.jpg", "subject": "x"}]), encoding="utf-8")
        (b / "meta.json").write_text(json.dumps({"intent": "hike"}), encoding="utf-8")
        s = sources(up)[0]
        # `duplicate` is a redundancy call, not a cull verdict — it must not
        # become a label here (D15).
        assert s["labels"] == {"a.jpg": "keep"}, s["labels"]
        assert s["intent"] == "hike" and s["untagged"] == []

        (b / "verdicts.json").write_text(json.dumps({"a.jpg": "keep", "c.jpg": "cut"}), encoding="utf-8")
        assert sources(up)[0]["untagged"] == ["c.jpg"], "untagged photo not reported"

        try:
            run(up)
            raise AssertionError("expected a refusal on an untagged batch")
        except RuntimeError as e:
            assert "tag these batches first" in str(e), e

    assert MINE["unsure"] == "edit" and "duplicate" not in MINE
    print("learning selftest ok")


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        demo()
    else:
        print(json.dumps(run(HERE / "uploads", print), indent=1))
