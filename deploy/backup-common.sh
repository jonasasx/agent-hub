# shellcheck shell=bash
# Helpers shared by backup.sh and backup-check.sh; sourced, not run.

# Daily dumps of backup.sh (no anchors: find -regex matches it against the whole path, grep against `<mtime> <name>`).
# shellcheck disable=SC2034 # used by backup.sh
DAILY_NAME='(agenthub|keycloak)-[0-9]{8}T[0-9]{6}Z\.dump'

# Last value of a key in an env file, without surrounding quotes. Usage: env_value <file> <KEY>
env_value() { sed -n "s/^$2=//p" "$1" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }

# Sends a message through the hub's Telegram bot (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID of the env file); without them only a warning.
# Never fails: an alert that cannot be sent must not hide the original error. Usage: telegram_send <env file> <text>
telegram_send() {
  local token chat
  token=$(env_value "$1" TELEGRAM_BOT_TOKEN 2>/dev/null || true)
  chat=$(env_value "$1" TELEGRAM_CHAT_ID 2>/dev/null || true)
  if [[ -n "$token" && -n "$chat" ]]; then
    # The URL carries the bot token: it goes to curl as a config on stdin (printf is a bash builtin), never as an argument,
    # so it does not show in `ps` or in the journal.
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
      curl -fsS -m 20 -K - --data-urlencode "chat_id=${chat}" --data-urlencode "text=$2" >/dev/null 2>&1 ||
      echo "warning: Telegram alert not sent (Bot API unreachable or refused)" >&2
  else
    echo "warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set in $1: no alert sent" >&2
  fi
}
