#!/bin/sh
# One race after another (they take ~25 s each; do not run them in parallel).
#   sh tools/bench/ai/sweep.sh <srcRoot> <outDir> <prefix> <layouts,comma> <seeds,comma> <normal|reverse> <difficulty> <laps> [seat: none|slow|fast] [mistakes: 0|1]
# <srcRoot> is the checkout (or an archived copy of one) whose src/ is measured; probe.ts is the one next to this script.
# Writes <outDir>/<prefix>_<layout>_<mode>_s<seed>.json and skips races already there.
here=$(cd "$(dirname "$0")" && pwd)
root=$1; out=$2; prefix=$3; layouts=$4; seeds=$5; mode=$6; diff=$7; laps=$8; seat=${9:-none}; mist=${10:-0}
mkdir -p "$out"
for layout in $(echo "$layouts" | tr ',' ' '); do
  for seed in $(echo "$seeds" | tr ',' ' '); do
    file="$out/${prefix}_${layout}_${mode}_s${seed}.json"
    [ -f "$file" ] && continue
    bun run "$here/probe.ts" "$root" "$layout" "$laps" "$seed" "$mode" "$diff" "$file" "$seat" "$mist" || echo "FAILED $file"
  done
done
