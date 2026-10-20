#!/usr/bin/env python3
"""Run the spec test suite and render the result as a video and a PNG summary.

Outputs (written to test-reports/):
  spec-tests.tap      raw TAP output from `node --test`
  spec-tests.json     parsed results (name, category, status, duration, error)
  spec-test-run.mp4   animated dashboard of the run (1280x720, H.264)
  spec-test-summary.png  final frame

Requirements (for rendering only; the tests themselves need Node 20.9+ and npm install):
  pip install pillow imageio-ffmpeg

Usage:
  npm install && python3 scripts/render_test_report.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
    import imageio_ffmpeg
except ImportError as exc:  # pragma: no cover
    sys.exit(f"Missing Python package ({exc}). Run: pip install pillow imageio-ffmpeg")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test-reports"
W, H = 1280, 720
FPS = 24

BG = (15, 20, 25)
PANEL = (24, 31, 39)
TEXT = (232, 237, 242)
MUTED = (140, 152, 165)
GREEN = (46, 160, 96)
RED = (218, 66, 66)
AMBER = (224, 165, 40)
BLUE = (86, 156, 230)
LINE = (46, 56, 68)

CATEGORY_COLOURS = {
    "schema": (86, 156, 230),
    "docs": (170, 128, 230),
    "PRD": (224, 165, 40),
    "env": (64, 180, 170),
    "status": (224, 110, 150),
}

# Result of the run before the schema fix. Recorded from the real output of that run.
HISTORY = {
    "label": "Earlier run, before the schema fix",
    "passed": 15,
    "failed": 1,
    "failing_test": "schema: every tenant-owned model relates to Business",
    "detail": "InventoryMovement, Shipment, DeliveryEvent and Job had a businessId but no "
              "relation to Business.",
    "resolution": "Relations added to all four models, with back-relations on Business. "
                  "Job's relation is optional. The test now accepts Business? as well.",
}

FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


F_TITLE = font(FONT_BOLD, 44)
F_H2 = font(FONT_BOLD, 26)
F_BODY = font(FONT_REG, 20)
F_SMALL = font(FONT_REG, 16)
F_ROW = font(FONT_REG, 17)
F_MONO = font(FONT_MONO, 15)
F_BIG = font(FONT_BOLD, 120)


def run(cmd, cwd=ROOT):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def parse_tap(tap_text):
    """Parse node:test TAP output into a list of result dicts."""
    lines = tap_text.splitlines()
    results = []
    i = 0
    while i < len(lines):
        m = re.match(r"^(ok|not ok) (\d+) - (.*)$", lines[i])
        if not m:
            i += 1
            continue
        status = "pass" if m.group(1) == "ok" else "fail"
        name = m.group(3).strip()
        duration = None
        error = None
        j = i + 1
        in_yaml = False
        while j < len(lines) and not re.match(r"^(ok|not ok) \d+ - ", lines[j]):
            if lines[j].strip() == "---":
                in_yaml = True
            elif lines[j].strip() == "...":
                break
            elif in_yaml:
                dm = re.match(r"\s+duration_ms: ([\d.]+)", lines[j])
                if dm:
                    duration = float(dm.group(1))
                if error is None and re.match(r"\s+error:", lines[j]):
                    error = lines[j].strip()
            j += 1
        category = name.split(":")[0] if ":" in name else "PRD" if name.startswith("PRD") else "other"
        results.append({
            "name": name,
            "category": category,
            "status": status,
            "duration_ms": round(duration or 0.0, 2),
            "error": error,
        })
        i = j + 1
    return results


def git_short_sha():
    r = run(["git", "rev-parse", "--short", "HEAD"])
    return r.stdout.strip() or "unknown"


def git_branch():
    r = run(["git", "branch", "--show-current"])
    return r.stdout.strip() or "unknown"


def text_width(draw, text, fnt):
    return draw.textlength(text, font=fnt)


def truncate(draw, text, fnt, max_w):
    if text_width(draw, text, fnt) <= max_w:
        return text
    while text and text_width(draw, text + "…", fnt) > max_w:
        text = text[:-1]
    return text + "…"


def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if text_width(draw, trial, fnt) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def base_frame():
    img = Image.new("RGB", (W, H), BG)
    return img, ImageDraw.Draw(img)


def draw_status_badge(d, x, y, status, frame_no):
    if status == "running":
        col, label = AMBER, "RUNNING"
    elif status == "pass":
        col, label = GREEN, "PASS"
    else:
        col, label = RED, "FAIL"
    w = 96
    d.rounded_rectangle([x, y, x + w, y + 24], radius=12, fill=col)
    tw = text_width(d, label, F_SMALL)
    d.text((x + (w - tw) / 2, y + 3), label, font=F_SMALL, fill=(255, 255, 255))
    if status == "running":
        # Spinning arc drawn to the left of the badge.
        angle = (frame_no * 18) % 360
        d.arc([x - 30, y + 3, x - 12, y + 21], start=angle, end=angle + 260, fill=AMBER, width=3)


def scene_title(run_info, frames_total, frame_no):
    img, d = base_frame()
    a = ease(frame_no / 24)
    alpha_color = lambda c: tuple(int(v * a + BG[k] * (1 - a)) for k, v in enumerate(c))
    d.text((80, 200), "Spec validation suite", font=F_TITLE, fill=alpha_color(TEXT))
    d.text((80, 262), "Application-software- · pre-application stage", font=F_H2, fill=alpha_color(BLUE))
    lines = [
        f"Branch: {run_info['branch']}",
        f"Commit: {run_info['commit']}",
        f"Node {run_info['node']} · Prisma {run_info['prisma']} · {run_info['date']}",
    ]
    for k, line in enumerate(lines):
        d.text((80, 340 + k * 36), line, font=F_MONO, fill=alpha_color(MUTED))
    d.text((80, 500), "What this run covers: the Prisma schema, the documentation links and "
                      "cross-references, the PRD requirement ids, and the .env template.",
           font=F_BODY, fill=alpha_color(TEXT))
    d.text((80, 534), "No application code exists yet, so no UI or API is exercised here.",
           font=F_BODY, fill=alpha_color(MUTED))
    return img


def scene_run(results, completed, running, frame_no):
    """Dashboard frame. Rows below `completed` show their final result, the row at
    `running` (if any) shows an animated RUNNING badge, the rest are pending."""
    img, d = base_frame()
    total = len(results)
    passed = sum(1 for r in results[:completed] if r["status"] == "pass")
    failed = completed - passed
    d.rectangle([0, 0, W, 78], fill=PANEL)
    d.text((40, 22), "Spec validation suite: running", font=F_H2, fill=TEXT)
    right = f"Passed {passed}    Failed {failed}    Total {total}"
    d.text((W - 40 - text_width(d, right, F_BODY), 27), right, font=F_BODY, fill=TEXT)
    d.rounded_rectangle([40, 96, W - 40, 112], radius=8, fill=LINE)
    fill_w = int((W - 80) * (completed / total))
    if fill_w > 0:
        d.rounded_rectangle([40, 96, 40 + fill_w, 112], radius=8, fill=GREEN if failed == 0 else RED)
    row_h = 31
    y0 = 136
    for idx, r in enumerate(results):
        y = y0 + idx * row_h
        d.text((60, y + 4), f"{idx + 1:02d}", font=F_MONO, fill=MUTED)
        if idx > completed or (idx == completed and idx != running):
            d.text((220, y + 3), truncate(d, r["name"], F_ROW, 860), font=F_ROW, fill=(70, 80, 92))
            continue
        col = CATEGORY_COLOURS.get(r["category"], MUTED)
        d.rounded_rectangle([110, y + 2, 110 + 84, y + 24], radius=10, fill=col)
        ctw = text_width(d, r["category"], F_SMALL)
        d.text((110 + (84 - ctw) / 2, y + 4), r["category"], font=F_SMALL, fill=(15, 20, 25))
        d.text((220, y + 3), truncate(d, r["name"], F_ROW, 860), font=F_ROW, fill=TEXT)
        if idx == running:
            draw_status_badge(d, 1150, y + 2, "running", frame_no)
        else:
            d.text((1060, y + 4), f"{r['duration_ms']:.1f} ms", font=F_SMALL, fill=MUTED)
            draw_status_badge(d, 1150, y + 2, r["status"], frame_no)
    d.text((40, H - 34), "Source: node --test (TAP), parsed by scripts/render_test_report.py",
           font=F_SMALL, fill=MUTED)
    return img


def scene_history(frame_no, span):
    img, d = base_frame()
    a = ease(frame_no / 18)
    d.rectangle([0, 0, W, 78], fill=PANEL)
    d.text((40, 22), "The first run was not clean", font=F_H2, fill=TEXT)
    y = 130
    d.rounded_rectangle([60, y, W - 60, y + 90], radius=14, fill=PANEL)
    d.text((86, y + 22), HISTORY["label"] + f": {HISTORY['passed']} passed, {HISTORY['failed']} failed",
           font=F_BODY, fill=TEXT)
    badge = Image.new("RGBA", (96, 24), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bd.rounded_rectangle([0, 0, 96, 24], radius=12, fill=RED)
    bd.text((18, 3), "FAIL", font=F_SMALL, fill=(255, 255, 255))
    img.paste(badge, (W - 60 - 130, y + 30), badge)
    y = 260
    d.text((60, y), "Failing test", font=F_SMALL, fill=MUTED)
    d.text((60, y + 26), HISTORY["failing_test"], font=F_H2, fill=RED)
    y = 340
    d.text((60, y), "Cause", font=F_SMALL, fill=MUTED)
    for k, line in enumerate(wrap(d, HISTORY["detail"], F_BODY, W - 120)):
        d.text((60, y + 26 + k * 30), line, font=F_BODY, fill=TEXT)
    y = 460
    d.text((60, y), "Fix", font=F_SMALL, fill=MUTED)
    for k, line in enumerate(wrap(d, HISTORY["resolution"], F_BODY, W - 120)):
        d.text((60, y + 26 + k * 30), line, font=F_BODY, fill=GREEN)
    # fade-in overlay
    if a < 1:
        overlay = Image.new("RGB", (W, H), BG)
        img = Image.blend(overlay, img, a)
    return img


def scene_summary(results, frame_no, total_ms):
    img, d = base_frame()
    total = len(results)
    passed = sum(1 for r in results if r["status"] == "pass")
    failed = total - passed
    a = ease(frame_no / 16)
    big = f"{passed} / {total}"
    colour = GREEN if failed == 0 else RED
    bw = text_width(d, big, F_BIG)
    d.text(((W - bw) / 2, 110), big, font=F_BIG, fill=tuple(int(c * a + BG[k] * (1 - a)) for k, c in enumerate(colour)))
    label = "tests passed" if failed == 0 else f"tests passed, {failed} failed"
    lw = text_width(d, label, F_H2)
    d.text(((W - lw) / 2, 255), label, font=F_H2, fill=TEXT)
    # category breakdown
    cats = {}
    for r in results:
        cats.setdefault(r["category"], [0, 0])
        cats[r["category"]][0 if r["status"] == "pass" else 1] += 1
    y = 330
    d.text((160, y), "By area", font=F_SMALL, fill=MUTED)
    for k, (cat, (p, f)) in enumerate(sorted(cats.items())):
        yy = y + 36 + k * 40
        col = CATEGORY_COLOURS.get(cat, MUTED)
        d.rounded_rectangle([160, yy, 160 + 110, yy + 28], radius=12, fill=col)
        d.text((160 + 14, yy + 4), cat, font=F_BODY, fill=(15, 20, 25))
        d.text((300, yy + 4), f"{p} passed" + (f", {f} failed" if f else ""), font=F_BODY, fill=TEXT)
    d.text((760, 330), "Run", font=F_SMALL, fill=MUTED)
    d.text((760, 366), f"Duration of tests: {total_ms / 1000:.2f} s", font=F_BODY, fill=TEXT)
    d.text((760, 402), "Scope: documentation and schema only.", font=F_BODY, fill=TEXT)
    d.text((760, 438), "No application code, UI or API was tested.", font=F_BODY, fill=TEXT)
    d.text((80, H - 60), "Reproduce: npm install && npm test · python3 scripts/render_test_report.py",
           font=F_SMALL, fill=MUTED)
    return img


def encode(frames_dir, out_path):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(frames_dir / "frame_%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
        "-movflags", "+faststart", str(out_path),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"ffmpeg failed:\n{r.stderr}")


def main():
    OUT.mkdir(exist_ok=True)
    print("Running spec tests...")
    proc = run(["node", "--test", "--test-reporter=tap", "tests/spec/spec.test.mjs"])
    tap = proc.stdout + proc.stderr
    (OUT / "spec-tests.tap").write_text(tap, encoding="utf-8")
    results = parse_tap(tap)
    if not results:
        sys.exit("No test results parsed. See test-reports/spec-tests.tap")
    total_ms = sum(r["duration_ms"] for r in results)
    passed = sum(1 for r in results if r["status"] == "pass")
    print(f"Parsed {len(results)} tests: {passed} passed, {len(results) - passed} failed")

    prisma_version = json.loads((ROOT / "node_modules/prisma/package.json").read_text())["version"] \
        if (ROOT / "node_modules/prisma/package.json").exists() else "not installed"
    run_info = {
        "branch": git_branch(),
        "commit": git_short_sha(),
        "node": run(["node", "-v"]).stdout.strip(),
        "prisma": prisma_version,
        "date": date.today().isoformat(),
    }
    (OUT / "spec-tests.json").write_text(json.dumps({
        "run": run_info,
        "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed,
                    "duration_ms": round(total_ms, 2)},
        "tests": results,
    }, indent=2), encoding="utf-8")

    frames_dir = Path(tempfile.mkdtemp(prefix="spec-frames-"))
    counter = {"n": 0}
    last = {"img": None}

    def add(img):
        # Frames are written to disk as they are made, so memory stays flat.
        img.save(frames_dir / f"frame_{counter['n']:05d}.png")
        counter["n"] += 1
        last["img"] = img

    for n in range(3 * FPS):
        add(scene_title(run_info, 3 * FPS, n))
    for idx in range(len(results)):
        # Each test: a RUNNING frame for 0.35 s, then its final result for 0.25 s.
        for n in range(int(0.35 * FPS)):
            add(scene_run(results, idx, idx, n))
        for n in range(int(0.25 * FPS)):
            add(scene_run(results, idx + 1, None, n))
    for n in range(2 * FPS):
        add(scene_history(n, None))
    for n in range(3 * FPS):
        add(scene_summary(results, n, total_ms))
    total_frames = counter["n"]
    out_video = OUT / "spec-test-run.mp4"
    encode(frames_dir, out_video)
    last["img"].save(OUT / "spec-test-summary.png")
    shutil.rmtree(frames_dir)
    print(f"Wrote {out_video.relative_to(ROOT)} ({total_frames / FPS:.1f} s, {total_frames} frames)")
    print("Wrote test-reports/spec-test-summary.png, spec-tests.json, spec-tests.tap")


if __name__ == "__main__":
    main()
