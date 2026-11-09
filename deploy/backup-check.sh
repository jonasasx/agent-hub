#!/usr/bin/env bash
# Freshness check of the daily backups (change agent-hub-mvp, task 5.4): for every database of backup.sh the newest daily dump
# must be younger than MAX_AGE_HOURS (36 by default) both in BACKUP_DIR and, when S3_BUCKET_BACKUPS is set in .env, in S3.
# Catches what backup.sh cannot report itself: the timer did not fire, the VM was down, the run hung or was killed.
# A stale or missing dump, or a check that cannot run, ends with a non-zero exit and a Telegram alert through the hub's bot.
# Run by agent-hub-backup-check.timer via `bash` (the exec bit is lost when scripts are synced from Windows).
# Usage: bash /home/ubuntu/agent-hub/deploy/backup-check.sh [max age in hours]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/backup-common.sh
source "$ROOT/deploy/backup-common.sh"
BACKUP_DIR=${BACKUP_DIR:-/home/ubuntu/agent-hub-backups}
MAX_AGE_HOURS=${1:-${MAX_AGE_HOURS:-36}}
HUB_ENV=${HUB_ENV_FILE:-$ROOT/.env}
DATABASES=(agenthub keycloak)
problems=()

fail() {
  trap - ERR
  echo "error: $1" >&2
  telegram_send "$HUB_ENV" "agent-hub backup check FAILED on $(hostname): $1"
  exit 1
}
trap 'fail "backup-check.sh stopped at line $LINENO"' ERR

[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || fail "max age must be a whole number of hours, got '$MAX_AGE_HOURS'"
[[ -f "$HUB_ENV" ]] || fail "$HUB_ENV is missing"
now=$(date +%s)
max_age=$((10#$MAX_AGE_HOURS * 3600))

# Records a problem when the newest dump is missing or too old. Usage: judge <where> <epoch of the newest dump or empty> <name>
judge() {
  if [[ -z "$2" ]]; then
    problems+=("$1: no dump")
    return
  fi
  local hours=$(((now - $2) / 3600))
  if ((now - $2 > max_age)); then
    problems+=("$1: newest $3 is ${hours} h old")
  else
    echo "ok: $1: $3 (${hours} h old)"
  fi
}

for db in "${DATABASES[@]}"; do
  newest=$(find "$BACKUP_DIR" -maxdepth 1 -type f -regextype posix-extended -regex ".*/$db-[0-9]{8}T[0-9]{6}Z\.dump" -printf '%T@ %f\n' 2>/dev/null |
    sort -rn | head -n1 || true)
  judge "$BACKUP_DIR/$db" "${newest%%.*}" "${newest#* }"
done

S3_BUCKET=$(env_value "$HUB_ENV" S3_BUCKET_BACKUPS)
if [[ -n "$S3_BUCKET" ]]; then
  S3_PREFIX=$(env_value "$HUB_ENV" S3_BACKUP_PREFIX)
  S3_PREFIX=${S3_PREFIX:-pg/}
  [[ "$S3_PREFIX" == */ ]] || S3_PREFIX+=/
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  # The hub's keys go to the aws CLI through the environment of this script only, never through arguments.
  AWS_ACCESS_KEY_ID=$(env_value "$HUB_ENV" AWS_ACCESS_KEY_ID)
  AWS_SECRET_ACCESS_KEY=$(env_value "$HUB_ENV" AWS_SECRET_ACCESS_KEY)
  AWS_DEFAULT_REGION=$(env_value "$HUB_ENV" AWS_REGION)
  AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-${AWS_REGION:-}}
  [[ -n "$AWS_DEFAULT_REGION" ]] || unset AWS_DEFAULT_REGION
  command -v aws >/dev/null || fail "aws CLI is not installed"
  [[ -n "$AWS_ACCESS_KEY_ID" && -n "$AWS_SECRET_ACCESS_KEY" ]] || fail "S3_BUCKET_BACKUPS is set, AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is not"
  for db in "${DATABASES[@]}"; do
    # The key policy allows ListBucket on the prefix: the newest object by key name (the name carries the UTC stamp of the run).
    # An empty prefix prints `None`, which matches no dump name.
    if ! keys=$(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$S3_PREFIX$db-" --query 'Contents[].Key' --output text); then
      problems+=("s3://$S3_BUCKET/$S3_PREFIX$db: cannot list")
      continue
    fi
    key=$(tr '\t' '\n' <<<"$keys" | grep -E "$db-[0-9]{8}T[0-9]{6}Z\.dump$" | sort | tail -n1 || true)
    stamp=''
    if [[ "$key" =~ $db-([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump$ ]]; then
      stamp=$(date -u -d "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}:${BASH_REMATCH[3]}:${BASH_REMATCH[4]}" +%s)
    fi
    judge "s3://$S3_BUCKET/$S3_PREFIX$db" "$stamp" "${key##*/}"
  done
fi

if ((${#problems[@]} > 0)); then
  trap - ERR
  text="agent-hub backup STALE on $(hostname) (limit ${MAX_AGE_HOURS} h):"
  for p in "${problems[@]}"; do
    echo "stale: $p" >&2
    text+=$'\n'"- $p"
  done
  telegram_send "$HUB_ENV" "$text"
  exit 1
fi
