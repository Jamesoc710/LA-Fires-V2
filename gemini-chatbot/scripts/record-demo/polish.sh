#!/usr/bin/env bash
# Post-process the raw demo capture into a polished mp4.
#
# Reads out/markers.json (ms offsets from recording start) and out/capture.webm,
# then:
#   - trims dead head/tail (takeStart..takeEnd)
#   - speed-ramps ONLY the dead skeleton/retrieval waits: any submit->firstPaint
#     span > 2.5s runs at 3x between submit+0.8s and firstPaint-0.4s. Every LLM
#     stream, keystroke, and settle stays at 1x (streams are the whole point).
#   - money-shot push-in: a slow zoompan over the beat-3 final hold, easing 1.0
#     -> 1.08 onto the centered amber citation chips (ZOOM=1 default; ZOOM=0 off)
#   - fade in from black (400ms) / fade out to black (500ms), no title cards
#   - output at the capture's native resolution, yuv420p, +faststart, no audio,
#     libx264 crf22; re-encodes 2-pass @850k if the crf output exceeds 6MB
#   - extracts a poster from the beat-1 cards (fire + fault overlay lines)
#
# Usage: bash scripts/record-demo/polish.sh
#   ZOOM=0                disable the push-in
#   POSTER_TS_OVERRIDE=s  force the poster timestamp (seconds into capture.webm)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
SRC="$OUT/capture.webm"
MARKERS="$OUT/markers.json"
DEST="$OUT/demo.mp4"
POSTER="$OUT/demo-poster.png"
ZOOM="${ZOOM:-1}"
MAX_BYTES=$((6 * 1024 * 1024))

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
[ -f "$MARKERS" ] || { echo "missing $MARKERS" >&2; exit 1; }

# Actual capture duration + native dimensions (output matches the capture; DSF
# is not applied to the frame, so this is the CSS viewport, e.g. 1280x800).
VIDEO_DUR=$(ffprobe -v error -select_streams v:0 -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$SRC")
CAP_W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width \
  -of default=noprint_wrappers=1:nokey=1 "$SRC")
CAP_H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height \
  -of default=noprint_wrappers=1:nokey=1 "$SRC")

# Build the ffmpeg filter_complex + fade/poster timings from the markers.
# python3 prints shell assignments we eval below.
eval "$(python3 - "$MARKERS" "$ZOOM" "$VIDEO_DUR" "$CAP_W" "$CAP_H" <<'PY'
import json, sys
mk = json.load(open(sys.argv[1]))
zoom = sys.argv[2] == "1"
video_dur = float(sys.argv[3])
W = int(sys.argv[4]); H = int(sys.argv[5])

def s(name):  # marker ms -> seconds
    return mk[name] / 1000.0

A = s("takeStart")
# takeEnd can exceed the captured video (context.close finalizes a hair early);
# clamp so trims and the fade-out math stay inside real footage.
Hn = min(s("takeEnd"), video_dur - 0.05)

SPEED   = 3.0    # ramp factor for dead skeleton/retrieval waits
GAP_MIN = 2.5    # only ramp submit->firstPaint spans longer than this
HEAD    = 0.8    # keep the first 0.8s after submit at 1x (skeleton appears)
TAIL    = 0.4    # keep the last 0.4s before paint at 1x (cards settle in)
NORM    = "fps=25,setsar=1"

# Fast windows: submit->firstPaint spans that are just a spinner. Speed ONLY
# that interior span; leave streams/typing/settles at 1x.
pairs = [("submit1", "cards1Painted"),
         ("submit2", "assessor2Painted"),
         ("submit3", "chips3Painted")]
fast = []
for a, b in pairs:
    if a in mk and b in mk:
        w0, w1 = s(a) + HEAD, s(b) - TAIL
        if s(b) - s(a) > GAP_MIN and w1 - w0 > 0.3:
            fast.append((max(w0, A), min(w1, Hn)))
fast.sort()

# Money-shot push-in span: the static final hold once the chips are centered.
Z0 = max(min(s("stream3End"), Hn), A)
do_zoom = zoom and (Hn - Z0) > 0.6

# Cut the [A..Hn] timeline at every fast-window edge and the zoom start.
cutset = {A, Hn}
if do_zoom:
    cutset.add(Z0)
for w0, w1 in fast:
    cutset.add(w0); cutset.add(w1)
cuts = sorted(c for c in cutset if A - 1e-9 <= c <= Hn + 1e-9)

def in_fast(t0, t1):
    m = (t0 + t1) / 2.0
    return any(w0 <= m < w1 for w0, w1 in fast)

segs = []
outdur = 0.0
for i in range(len(cuts) - 1):
    c0, c1 = cuts[i], cuts[i + 1]
    if c1 - c0 < 0.05:
        continue
    idx = len(segs)
    if do_zoom and c0 >= Z0 - 1e-6:
        # Ease z 1.0 -> 1.08 over `rin` seconds (starting at 1.0 = no pop from
        # the preceding 1x segment), then hold; the fade-out covers the tail.
        dur = c1 - c0
        rin = min(1.2, dur * 0.6)
        env = f"min(1\\,on/25/{rin:.3f})"
        z = f"1+0.08*{env}"
        # Pin the LEFT edge (content is left-anchored; the right margin is empty,
        # so all horizontal crop must come from the right) and the BOTTOM edge
        # (the push-in slides down toward the answer + chips; the header exits
        # top-of-frame instead of labels getting clipped mid-word).
        zp = (f"zoompan=z='{z}':x='0':y='trunc(ih-ih/zoom)'"
              f":d=1:s={W}x{H}:fps=25")
        segs.append(f"[0:v]trim={c0:.3f}:{c1:.3f},setpts=(PTS-STARTPTS),{zp},setsar=1[s{idx}]")
        outdur += dur
    else:
        speed = SPEED if in_fast(c0, c1) else 1.0
        segs.append(f"[0:v]trim={c0:.3f}:{c1:.3f},setpts=(PTS-STARTPTS)/{speed},{NORM}[s{idx}]")
        outdur += (c1 - c0) / speed

n = len(segs)
concat = "".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[cat]"
fo = max(outdur - 0.5, 0.0)
tail = (f"[cat]scale={W}:{H}:flags=lanczos,format=yuv420p,"
        f"fade=t=in:st=0:d=0.4,fade=t=out:st={fo:.3f}:d=0.5[out]")

fc = ";".join(segs + [concat, tail])

# Poster: the beat-1 Overlays card in full (the fire + fault hazard lines), read
# straight from the un-ramped capture. Aim just after the first narrative token
# (stream1Start) so the thinking dots are gone. The narrative streams in a bubble
# above the cards, so bottom-stick keeps the Overlays card framed.
poster_ts = (s("stream1Start") if "stream1Start" in mk else s("cards1Painted")) + 0.5

print(f"FILTER={json.dumps(fc)}")
print(f"POSTER_TS={poster_ts:.3f}")
print(f"OUT_DUR={outdur:.3f}")
print(f"OUT_W={W}")
print(f"OUT_H={H}")
PY
)"

POSTER_TS="${POSTER_TS_OVERRIDE:-$POSTER_TS}"
echo "[polish] ZOOM=$ZOOM  ${OUT_W}x${OUT_H}  output≈${OUT_DUR}s  poster@${POSTER_TS}s"

encode() { # $1 = crf|twopass
  if [ "$1" = "crf" ]; then
    ffmpeg -y -i "$SRC" -filter_complex "$FILTER" -map "[out]" \
      -c:v libx264 -crf 22 -preset veryslow -pix_fmt yuv420p \
      -movflags +faststart -an "$DEST" >"$OUT/ffmpeg-encode.log" 2>&1
  else
    ffmpeg -y -i "$SRC" -filter_complex "$FILTER" -map "[out]" \
      -c:v libx264 -b:v 850k -preset veryslow -pix_fmt yuv420p -pass 1 \
      -passlogfile "$OUT/x264" -an -f mp4 /dev/null >"$OUT/ffmpeg-pass1.log" 2>&1
    ffmpeg -y -i "$SRC" -filter_complex "$FILTER" -map "[out]" \
      -c:v libx264 -b:v 850k -preset veryslow -pix_fmt yuv420p -pass 2 \
      -passlogfile "$OUT/x264" -movflags +faststart -an "$DEST" \
      >"$OUT/ffmpeg-pass2.log" 2>&1
  fi
}

echo "[polish] encoding (crf 22 veryslow)..."
encode crf

SIZE=$(stat -f%z "$DEST" 2>/dev/null || stat -c%s "$DEST")
echo "[polish] crf output: $SIZE bytes"
if [ "$SIZE" -gt "$MAX_BYTES" ]; then
  echo "[polish] > 6MB, re-encoding 2-pass @850k..."
  encode twopass
  rm -f "$OUT"/x264-*.log "$OUT"/x264-*.log.mbtree 2>/dev/null || true
  SIZE=$(stat -f%z "$DEST" 2>/dev/null || stat -c%s "$DEST")
  echo "[polish] 2-pass output: $SIZE bytes"
fi

echo "[polish] extracting poster @ ${POSTER_TS}s (pre-ramp)..."
ffmpeg -y -ss "$POSTER_TS" -i "$SRC" -frames:v 1 \
  -vf "scale=${OUT_W}:${OUT_H}:flags=lanczos" "$POSTER" >"$OUT/ffmpeg-poster.log" 2>&1

echo "[polish] done -> $DEST"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,duration,bit_rate,nb_frames \
  -show_entries format=duration,size,bit_rate \
  -of default=noprint_wrappers=1 "$DEST"
