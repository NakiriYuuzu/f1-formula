#!/bin/sh
# Export this checkout's src/ to <dest> (a tree probe.ts / sweep.sh can measure), optionally applying a patch file with -p1.
#   sh tools/bench/ai/mkvar.sh <dest> [patch]
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
dest=$1
rm -rf "$dest" && mkdir -p "$dest"
cp -R "$root/src" "$root/package.json" "$root/tsconfig.json" "$dest/"
[ -n "$2" ] && (cd "$dest" && patch -p1 < "$2")
exit 0
