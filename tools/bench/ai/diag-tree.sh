#!/bin/sh
# Export src/ of a checkout (default: this one) to <dest> and apply diag-gates.patch (ai.dbg* fields for gates.ts / trace.ts).
#   sh tools/bench/ai/diag-tree.sh <dest> [srcRoot]
here=$(cd "$(dirname "$0")" && pwd)
dest=$1; root=${2:-$(cd "$here/../../.." && pwd)}
rm -rf "$dest" && mkdir -p "$dest"
cp -R "$root/src" "$root/package.json" "$root/tsconfig.json" "$dest/" 2>/dev/null
(cd "$dest" && patch -p1 --fuzz=3 < "$here/diag-gates.patch")
