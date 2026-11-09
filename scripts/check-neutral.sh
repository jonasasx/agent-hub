#!/usr/bin/env bash
# Fails when tracked files mention a specific installation (openspec change installation-neutral, D6).
#   bash scripts/check-neutral.sh <patterns-file> [<dir>]
# Patterns file: one extended regex per line, matched case-insensitively; `#` starts a comment;
# a line `!<pathspec>` excludes those paths. Without <dir> the tracked files of this repository are checked,
# with <dir> every text file under it (publish-github.sh passes its snapshot); there `!` lines are bare file or directory names.
set -euo pipefail

FILE="${1:?usage: check-neutral.sh <patterns-file> [<dir>]}"
DIR="${2:-}"

BOM=$'\xEF\xBB\xBF'
PATTERNS=()
EXCLUDES=()
while IFS= read -r line || [[ -n $line ]]; do
  line="${line%$'\r'}"
  line="${line#"$BOM"}"
  [[ -z $line || $line == \#* ]] && continue
  if [[ $line == !* ]]; then
    EXCLUDES+=("${line:1}")
  else
    PATTERNS+=("$line")
  fi
done <"$FILE"

if [[ ${#PATTERNS[@]} == 0 ]]; then
  echo "error: no patterns in $FILE" >&2
  exit 2
fi

ARGS=()
for p in "${PATTERNS[@]}"; do
  rc=0
  grep -E -e "$p" </dev/null >/dev/null 2>&1 || rc=$?
  if ((rc > 1)); then
    echo "error: invalid pattern: $p" >&2
    exit 2
  fi
  ARGS+=(-e "$p")
done

if [[ -z $DIR ]]; then
  ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
  SPECS=(.)
  for x in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
    SPECS+=(":(exclude)$x")
  done
  rc=0
  OUT="$(git -C "$ROOT" grep -nIiE "${ARGS[@]}" -- "${SPECS[@]}")" || rc=$?
else
  SKIP=()
  for x in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
    SKIP+=(--exclude-dir="$x" --exclude="$x")
  done
  cd "$DIR" || exit 2
  rc=0
  OUT="$(grep -rnIiE ${SKIP[@]+"${SKIP[@]}"} "${ARGS[@]}" .)" || rc=$?
fi

# grep exits 1 when nothing matched; anything above 1 is an error, not a clean result.
if ((rc > 1)); then
  echo "error: search failed (exit $rc)" >&2
  exit 2
fi

if [[ -n $OUT ]]; then
  echo "error: installation-specific strings:" >&2
  echo "$OUT" | cut -c1-200 >&2
  exit 1
fi
echo "neutral: no matches"
