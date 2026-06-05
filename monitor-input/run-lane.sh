#!/usr/bin/env bash
# Lane runner — sequential segments, each: find-support -> scan -> classify -> aggregate.
# Usage: bash run-lane.sh "SEG:slug" "SEG:slug:skip-enrich" ...
cd "C:/dev/orch/.claude/worktrees/festive-wing-5a90e8" || exit 1

run_segment() {
  local SEG="$1" SLUG="$2" SKIP="$3"
  echo "=== SEGMENT START: $SEG ($SLUG) ==="
  local IN="./monitor-input/$SLUG-enriched.csv"
  if [ "$SKIP" != "skip-enrich" ]; then
    node src/videoscan/monitor/find-support-urls.mjs \
      --input "./monitor-input/$SLUG.csv" --output "$IN" \
      || { echo "=== SEGMENT FAILED: $SEG (find-support) ==="; return 1; }
    echo "=== FINDSUPPORT DONE: $SLUG ==="
  fi
  node src/videoscan/monitor/run-monitor.mjs --input "$IN" --segment "$SEG" \
    || { echo "=== SEGMENT FAILED: $SEG (scan) ==="; return 1; }
  node src/videoscan/monitor/classify-explainer.mjs --segment "$SEG" \
    || { echo "=== SEGMENT FAILED: $SEG (classify) ==="; return 1; }
  node src/videoscan/monitor/aggregate-monitor.mjs --segment "$SEG" \
    || { echo "=== SEGMENT FAILED: $SEG (aggregate) ==="; return 1; }
  echo "=== SEGMENT DONE: $SEG ==="
}

FAILED=0
for spec in "$@"; do
  IFS=':' read -r seg slug skip <<< "$spec"
  run_segment "$seg" "$slug" "$skip" || FAILED=1
done
echo "=== LANE COMPLETE (failed=$FAILED) ==="
exit $FAILED
