#!/usr/bin/env bash
# Agent Hub: connect this machine (Linux, macOS) — change `multi-user`, design M5, spec runner-enrollment «Установщик».
# The hub serves this file at /install.sh with __HUB_URL__ replaced by its public address; the window
# «Подключить машину» shows the command with a one-time code:
#   curl -fsSL https://hub.example.com/install.sh | bash -s -- <code>
#   curl -fsSL https://hub.example.com/install.sh | bash -s -- <code> --daemon   # macOS: LaunchDaemon (Mac mini, sudo)
#   … | bash -s -- <code> --allow-root   # install under root anyway (sessions only in modes that ask for permissions)
# Everything goes to ~/.agent-hub (Node, agent, agent.env, logs, bin/agent-hub, uninstall.sh); `claude` comes from its
# official installer (~/.local/bin). Running it again with a new code updates the agent and the token, other settings
# in agent.env stay. Remove: ~/.agent-hub/uninstall.sh (~/.claude and session transcripts are not touched).
#
# Overrides (tests, trial installs): AGENT_HUB_URL, AGENT_HUB_HOME, AGENT_HUB_NODE_DIST, AGENT_HUB_CLAUDE_INSTALL_URL,
# AGENT_HUB_NO_OPEN=1 (macOS: do not open System Settings), AGENT_HUB_WAIT_SEC (wait for the hub connection, 40).
set -euo pipefail

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '!  %s\n' "$*" >&2; }
die() {
  printf 'Ошибка: %s\n' "$1" >&2
  exit "${2:-1}"
}

# The whole script is one function called on the last line: with `curl | bash` bash has read all of it before any
# command runs, so a child that reads stdin cannot eat the rest of the script.
main() {
  local hub="${AGENT_HUB_URL:-__HUB_URL__}"
  hub="${hub%/}"
  [[ "$hub" == __* ]] && die "адрес хаба не подставлен; скопируйте команду из окна «Подключить машину»"
  [[ "$hub" =~ ^https?:// ]] || die "неверный адрес хаба: $hub"

  local code="" daemon=0 allow_root=0 a
  for a in "$@"; do
    case "$a" in
      --daemon) daemon=1 ;;
      --allow-root) allow_root=1 ;;
      -h | --help)
        say "usage: curl -fsSL $hub/install.sh | bash -s -- <код> [--daemon] [--allow-root]"
        return 0
        ;;
      -*) die "неизвестный параметр $a" ;;
      *) code="$a" ;;
    esac
  done
  [[ -n "$code" ]] || die "нет кода подключения: скопируйте команду из окна «Подключить машину» в браузере"

  # ---- root (spec «Запуск под root»): Claude Code refuses bypassPermissions under uid 0 outside a sandbox (IS_SANDBOX=1,
  # CLAUDE_CODE_BUBBLEWRAP), the default mode of new sessions. Stop before the hub is contacted: the code is not spent.
  if [[ "$(id -u)" == 0 && "${IS_SANDBOX:-}" != 1 && -z "${CLAUDE_CODE_BUBBLEWRAP:-}" ]]; then
    if [[ "$allow_root" != 1 ]]; then
      cat >&2 << EOF
Установка под root остановлена: Claude Code не разрешает режим без запросов разрешений (bypassPermissions)
под root — сессии в этом режиме будут падать.

Создайте обычного пользователя и запустите команду под ним (код ещё действует):
  adduser agent && su - agent
  curl -fsSL $hub/install.sh | bash -s -- $code

Продолжить под root — добавьте --allow-root: сессии тогда только в режимах с запросом разрешений.
EOF
      exit 6
    fi
    warn "агент будет работать под root: режим bypassPermissions недоступен, сессии — в режимах с запросом разрешений"
  fi

  # ---- platform ----
  local os arch kernel machine
  kernel="$(uname -s)"
  machine="$(uname -m)"
  case "$kernel" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) die "система $kernel не поддерживается (нужны Linux или macOS; для Windows — команда PowerShell из окна подключения)" ;;
  esac
  case "$machine" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "архитектура $machine не поддерживается (нужны x64 или arm64)" ;;
  esac
  # A Terminal under Rosetta reports x86_64 on Apple silicon: the agent should run natively.
  if [[ "$os" == macos && "$arch" == x64 && "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == 1 ]]; then arch=arm64; fi
  if [[ "$os" == linux ]] && ldd --version 2>&1 | grep -qi musl; then
    die "musl (Alpine) не поддерживается: официальные сборки Node.js требуют glibc"
  fi
  if [[ "$daemon" == 1 && "$os" != macos ]]; then
    warn "--daemon только для macOS; на Linux автозапуск выбирается сам"
    daemon=0
  fi
  local t
  for t in curl tar; do command -v "$t" > /dev/null || die "нет $t: установите его и запустите команду снова"; done

  local state="${AGENT_HUB_HOME:-$HOME/.agent-hub}"
  export AGENT_HUB_HOME="$state"
  local app="$state/app" user
  user="$(id -un)"
  mkdir -p "$state"
  chmod 700 "$state"
  local tmp
  tmp="$(mktemp -d "$state/install.XXXXXX")"
  # shellcheck disable=SC2064 # expand now: the trap runs after main's locals are gone
  trap "rm -rf '$tmp'" EXIT

  say "Agent Hub: подключение машины $(hostname) ($os $arch) к $hub"

  # Order (spec «Установщик», re-install): everything new is prepared in $tmp and the code is exchanged first; the
  # running agent, its Node, app/ and app/versions/ are touched only after a successful exchange — an expired code or
  # a failed download leaves the installed agent online.

  # ---- the hub is reachable (spec «Машина не достаёт хаб») ----
  step "Проверяем связь с хабом"
  local hostport rc=0
  hostport="${hub#*://}"
  hostport="${hostport%%/*}"
  if [[ "$hostport" != *:* ]]; then
    if [[ "$hub" == https://* ]]; then hostport="$hostport:443"; else hostport="$hostport:80"; fi
  fi
  curl -fsS --max-time 30 -o "$tmp/latest.json" "$hub/agent/latest.json" 2> "$tmp/curl.err" || rc=$?
  if [[ "$rc" == 22 ]]; then
    die "хаб не отдаёт сборку агента ($(tr -d '\n' < "$tmp/curl.err")); сообщите владельцу хаба"
  elif [[ "$rc" != 0 ]]; then
    die "Нет связи с $hostport — проверьте выход машины в интернет" 3
  fi
  say "Связь есть."

  # ---- Node.js 22 in ~/.agent-hub/node (a new one is unpacked into $tmp and moved in after the exchange) ----
  step "Node.js"
  local node="$state/node/bin/node" node_dir="$state/node" run_dir
  if [[ -x "$node" ]] && "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2> /dev/null; then
    say "Есть: $("$node" --version)"
    run_dir="$node_dir"
  else
    run_dir="$tmp/node"
    install_node "$os" "$arch" "$tmp" "$run_dir"
  fi
  local run_node="$run_dir/bin/node"
  local npm_cli="$run_dir/lib/node_modules/npm/bin/npm-cli.js"

  # ---- claude ----
  step "Claude Code"
  local claude
  claude="$(find_claude)"
  if [[ -z "$claude" ]]; then
    say "Ставим claude официальным установщиком…"
    curl -fsSL "${AGENT_HUB_CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}" | bash > "$tmp/claude-install.log" 2>&1 ||
      die "claude не установился (журнал: $(tail -n 5 "$tmp/claude-install.log" | tr '\n' ' '))"
    claude="$(find_claude)"
    [[ -n "$claude" ]] || die "claude не найден после установки"
  fi
  say "Есть: $("$claude" --version < /dev/null 2> /dev/null | head -n 1) ($claude)"
  # The agent finds claude by full path, but the user's shell may not: the official installer does not always edit PATH.
  if ! command -v claude > /dev/null 2>&1; then
    local rc="$HOME/.bashrc"
    [[ "${SHELL:-}" == */zsh ]] && rc="$HOME/.zshrc"
    warn "Команда claude не видна в терминале. Чтобы запускать её вручную, добавьте папку в PATH:"
    warn "  echo 'export PATH=\"$(dirname "$claude"):\$PATH\"' >> $rc && source $rc"
  fi

  # ---- the agent build from the hub, SHA-256 from latest.json, prepared in $tmp/agent ----
  step "Агент"
  local meta version sha url
  meta="$("$run_node" -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
    if (!new RegExp("^" + v + "$").test(j.version) || !/^[0-9a-f]{64}$/.test(j.sha256) || j.url !== "/agent/agent-" + j.version + ".tgz") process.exit(1);
    console.log([j.version, j.sha256, j.url].join(" "));' "$tmp/latest.json")" || die "хаб вернул неверный latest.json"
  read -r version sha url <<< "$meta"
  curl -fsS --max-time 300 -o "$tmp/agent.tgz" "$hub$url" || die "не удалось скачать агента с хаба" 3
  [[ "$(sha256_of "$tmp/agent.tgz")" == "$sha" ]] || die "сборка агента не совпала по SHA-256 — установка остановлена"
  local stage="$tmp/agent"
  mkdir -p "$stage"
  tar -xzf "$tmp/agent.tgz" -C "$stage"
  if [[ ! -f "$stage/agent.mjs" && -f "$stage/package/agent.mjs" ]]; then
    (shopt -s dotglob && mv "$stage/package/"* "$stage/" && rmdir "$stage/package")
  fi
  [[ -f "$stage/agent.mjs" && -f "$stage/supervisor.mjs" && -f "$stage/cli.mjs" ]] || die "в сборке агента нет agent.mjs / supervisor.mjs / cli.mjs"
  say "Ставим зависимости агента (Agent SDK)…"
  (cd "$stage" && PATH="$run_dir/bin:$PATH" "$run_node" "$npm_cli" install --omit=dev --no-audit --no-fund --loglevel=error < /dev/null > "$tmp/npm.log" 2>&1) ||
    die "npm install не прошёл: $(tail -n 5 "$tmp/npm.log" | tr '\n' ' ')"

  # ---- login to Claude (spec «Нет входа в Claude»); --no-restart: a running agent is left alone ----
  step "Вход в Claude"
  # Into a variable, not `| grep -q`: under pipefail grep closing the pipe early fails the status command (SIGPIPE).
  local claude_status
  claude_status="$("$run_node" "$stage/cli.mjs" claude-status < /dev/null 2> /dev/null || true)"
  if [[ "$claude_status" == *'"login":"ok"'* ]]; then
    say "Вход есть."
  elif { : < /dev/tty; } 2> /dev/null; then
    # The real device (/dev/ttys003), not /dev/tty: macOS kqueue rejects /dev/tty with EINVAL, and claude (Bun) dies on it.
    local tty_dev
    tty_dev="$(tty < /dev/tty 2> /dev/null || true)"
    [[ -c "$tty_dev" ]] || tty_dev=/dev/tty
    "$run_node" "$stage/cli.mjs" login --no-restart < "$tty_dev" ||
      warn "Вход в Claude не выполнен. Позже: $state/bin/agent-hub login"
  else
    warn "Нет входа в Claude и нет терминала для входа. После установки выполните: $state/bin/agent-hub login"
  fi

  # ---- one-time code → runner token in agent.env (600), never printed ----
  # A running agent keeps its old token in memory; the hub accepts it until the agent connects with the new one.
  step "Подключаем машину к хабу"
  rc=0
  "$run_node" "$stage/cli.mjs" enroll --hub "$hub" --code "$code" --os "$os" --arch "$arch" < /dev/null || rc=$?
  [[ "$rc" == 0 ]] || exit "$rc"
  # ---- the exchange went through: the code is spent. From here any failure (sudo, systemctl, mv, launchctl) says
  # what to do and tries to start the previous autostart entry again (spec «Установщик», «Сбой после обмена кода»).
  # errtrace: the trap also fires inside the functions below.
  set -o errtrace
  # shellcheck disable=SC2064 # expand now: the trap runs after main's locals are gone
  trap "after_exchange_failed '$state' \"\$BASH_COMMAND\"" ERR
  chmod 600 "$state/agent.env"
  stop_agent "$state" "$os"
  if [[ "$run_dir" != "$node_dir" ]]; then
    rm -rf "$node_dir"
    mv "$run_dir" "$node_dir"
    say "Node.js $("$node" --version) в $node_dir"
  fi
  mkdir -p "$app/versions" "$state/bin"
  local vdir="$app/versions/$version"
  rm -rf "$vdir"
  mv "$stage" "$vdir"
  printf '%s' "$version" > "$app/current"
  rm -f "$app/next" "$app/update-result.json"
  local f
  for f in supervisor.mjs supervisor.mjs.map cli.mjs cli.mjs.map; do
    if [[ -f "$vdir/$f" ]]; then cp "$vdir/$f" "$app/$f"; fi
  done
  # The layout before self-update (app/agent.mjs + app/node_modules) and older versions are not needed any more.
  rm -rf "$app/node_modules" "$app/agent.mjs" "$app/agent.mjs.map" "$app/package.json" "$app/package-lock.json" "$app/s4u-check.mjs"
  for f in "$app/versions/"*; do
    if [[ "$f" != "$vdir" ]]; then rm -rf "$f"; fi
  done
  say "Агент $version."

  # ---- bin/agent-hub and uninstall.sh ----
  write_bin "$state" "$node"
  write_uninstall "$state"

  # ---- autostart ----
  step "Автозапуск"
  local log="$state/agent.log" offset=0
  if [[ -f "$log" ]]; then offset="$(wc -c < "$log" | tr -d ' ')"; fi
  # Not `autostart_linux || started=0`: in a `||` list errexit and the ERR trap are off inside the function.
  AUTOSTART_STARTED=1
  if [[ "$os" == linux ]]; then
    autostart_linux "$state" "$node" "$user"
  else
    autostart_macos "$state" "$node" "$user" "$daemon"
    full_disk_access_hint "$node"
  fi
  trap - ERR
  if [[ "$AUTOSTART_STARTED" == 0 ]]; then
    say ""
    say "Машина подключена, но агент не запущен. Запустить вручную (до выхода из сеанса):"
    say "  nohup $state/bin/agent-hub-agent > /dev/null 2>&1 &"
    exit 4
  fi

  # The hub refused the new token: no «Готово», exit 5.
  wait_connected "$log" "$offset" "${AGENT_HUB_WAIT_SEC:-40}" || exit 5
  say ""
  say "Готово, вернитесь в браузер"
}

find_claude() {
  local c
  c="$(command -v claude 2> /dev/null || true)"
  if [[ -z "$c" && -x "$HOME/.local/bin/claude" ]]; then c="$HOME/.local/bin/claude"; fi
  printf '%s' "$c"
}

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Official archive of the latest 22.x for this OS/arch, checked against SHASUMS256.txt.
# Unpacks into <dest> (a directory in the install's tmp; moved to ~/.agent-hub/node after the exchange).
install_node() {
  local os="$1" arch="$2" tmp="$3" dest="$4"
  local dist="${AGENT_HUB_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}" plat file expected
  if [[ "$os" == macos ]]; then plat=darwin; else plat=linux; fi
  curl -fsS --max-time 60 -o "$tmp/SHASUMS256.txt" "$dist/SHASUMS256.txt" || die "не удалось получить список сборок Node.js ($dist)" 3
  file="$(grep -oE "node-v[0-9]+\.[0-9]+\.[0-9]+-$plat-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n 1 || true)"
  [[ -n "$file" ]] || die "нет сборки Node.js для $plat-$arch"
  expected="$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
  say "Скачиваем ${file}…"
  curl -fsS --max-time 600 -o "$tmp/$file" "$dist/$file" || die "не удалось скачать Node.js" 3
  [[ "$(sha256_of "$tmp/$file")" == "$expected" ]] || die "Node.js не совпал по SHA-256 с SHASUMS256.txt — установка остановлена"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tmp/$file" -C "$dest" --strip-components=1
}

write_bin() {
  local state="$1" node="$2"
  cat > "$state/bin/agent-hub" << EOF
#!/bin/sh
# Agent Hub agent command: login (вход в Claude), restart, claude-status.
AGENT_HUB_HOME="\${AGENT_HUB_HOME:-$state}" exec "$node" "$state/app/cli.mjs" "\$@"
EOF
  cat > "$state/bin/agent-hub-agent" << EOF
#!/bin/sh
# Runs the agent in the foreground (what the autostart entry runs).
cd "$state/app" && exec "$node" --env-file="$state/agent.env" "$state/app/supervisor.mjs"
EOF
  chmod 755 "$state/bin/agent-hub" "$state/bin/agent-hub-agent"
}

write_uninstall() {
  local state="$1"
  cat > "$state/uninstall.sh" << EOF
#!/usr/bin/env bash
# Removes the Agent Hub agent: the autostart entry and $state. ~/.claude and session transcripts are not touched.
set -uo pipefail
STATE="$state"
EOF
  cat >> "$state/uninstall.sh" << 'EOF'
SUDO=""
[[ "$(id -u)" == 0 ]] || SUDO=sudo
line="$(cat "$STATE/autostart" 2> /dev/null || echo none)"
kind="${line%% *}"
name="${line#* }"
case "$kind" in
  systemd-system)
    $SUDO systemctl disable --now "$name" 2> /dev/null
    $SUDO rm -f "/etc/systemd/system/$name"
    $SUDO systemctl daemon-reload
    ;;
  systemd-user)
    systemctl --user disable --now "$name" 2> /dev/null
    rm -f "$HOME/.config/systemd/user/$name"
    systemctl --user daemon-reload 2> /dev/null
    ;;
  launchd-agent)
    launchctl bootout "gui/$(id -u)/$name" 2> /dev/null
    rm -f "$HOME/Library/LaunchAgents/$name.plist"
    ;;
  launchd-daemon)
    $SUDO launchctl bootout "system/$name" 2> /dev/null
    $SUDO rm -f "/Library/LaunchDaemons/$name.plist"
    ;;
esac
# A manually started agent (no autostart) and its Claude Code sessions.
pkill -f "$STATE/app/" 2> /dev/null
rm -rf "$STATE"
echo "Агент Agent Hub удалён. ~/.claude и транскрипты сессий не тронуты."
EOF
  chmod 755 "$state/uninstall.sh"
}

# Stops whatever runs the agent now (re-install), including the unit of the installs before multi-user.
stop_agent() {
  local state="$1" os="$2" line kind name sudo=""
  [[ "$(id -u)" == 0 ]] || sudo=sudo
  line="$(cat "$state/autostart" 2> /dev/null || echo none)"
  kind="${line%% *}"
  name="${line#* }"
  case "$kind" in
    systemd-system) $sudo systemctl stop "$name" 2> /dev/null || true ;;
    systemd-user) systemctl --user stop "$name" 2> /dev/null || true ;;
    launchd-agent) launchctl bootout "gui/$(id -u)/$name" 2> /dev/null || true ;;
    launchd-daemon) $sudo launchctl bootout "system/$name" 2> /dev/null || true ;;
  esac
  if [[ "$os" == linux ]] && command -v systemctl > /dev/null && [[ -f /etc/systemd/system/agent-hub-agent.service ]] && can_sudo; then
    $sudo systemctl disable --now agent-hub-agent.service 2> /dev/null || true
    $sudo rm -f /etc/systemd/system/agent-hub-agent.service
    $sudo systemctl daemon-reload 2> /dev/null || true
    say "Старый unit agent-hub-agent.service удалён."
  fi
  pkill -f "$state/app/" 2> /dev/null || true
}

# ERR after the code exchange: the hub already holds the new token, the old agent is (being) stopped. Tell the user to
# start over with a new code and try to bring back the autostart entry of the previous install (its files may be
# partly replaced: best effort, every step may fail).
after_exchange_failed() {
  local rc=$? state="$1" failed="$2" line kind name sudo="" uid
  trap - ERR
  set +e
  [[ "$(id -u)" == 0 ]] || sudo=sudo
  uid="$(id -u)"
  line="$(cat "$state/autostart" 2> /dev/null || echo none)"
  kind="${line%% *}"
  name="${line#* }"
  case "$kind" in
    systemd-system) ${sudo:+$sudo -n} systemctl start "$name" > /dev/null 2>&1 ;;
    systemd-user) systemctl --user start "$name" > /dev/null 2>&1 ;;
    launchd-agent)
      launchctl bootstrap "gui/$uid" "$HOME/Library/LaunchAgents/$name.plist" > /dev/null 2>&1
      launchctl kickstart "gui/$uid/$name" > /dev/null 2>&1
      ;;
    launchd-daemon)
      ${sudo:+$sudo -n} launchctl bootstrap system "/Library/LaunchDaemons/$name.plist" > /dev/null 2>&1
      ${sudo:+$sudo -n} launchctl kickstart "system/$name" > /dev/null 2>&1
      ;;
  esac
  printf '\nОшибка: установка прервалась после подключения машины (код %s, шаг: %s).\n' "$rc" "$failed" >&2
  if [[ "$kind" != none ]]; then
    printf 'Пробуем снова запустить прежний агент (%s %s).\n' "$kind" "$name" >&2
  fi
  printf 'Нажмите «Переподключить» в хабе и запустите новую команду.\n' >&2
  exit "$rc"
}

can_sudo() {
  [[ "$(id -u)" == 0 ]] || { command -v sudo > /dev/null && sudo -n true 2> /dev/null; }
}

# Linux: a system unit under the current user when root or passwordless sudo is available, else systemd --user + linger.
# No systemd (or no --user session): AUTOSTART_STARTED=0, the caller prints how to start the agent by hand.
autostart_linux() {
  local state="$1" node="$2" user="$3"
  if ! command -v systemctl > /dev/null || [[ ! -d /run/systemd/system ]]; then
    printf 'none\n' > "$state/autostart"
    warn "На этой машине нет systemd: автозапуск не настроен."
    AUTOSTART_STARTED=0
    return 0
  fi
  local exec_start="\"$node\" \"--env-file=$state/agent.env\" \"$state/app/supervisor.mjs\""
  local path_line="Environment=\"PATH=$HOME/.local/bin:$state/node/bin:/usr/local/bin:/usr/bin:/bin\""
  if can_sudo; then
    local sudo="" unit="agent-hub-agent@$user.service"
    [[ "$(id -u)" == 0 ]] || sudo=sudo
    {
      printf '%s\n' "# Agent Hub agent of $user (installed by $state; remove: $state/uninstall.sh)."
      printf '%s\n' '[Unit]' 'Description=Agent Hub agent' 'After=network-online.target' 'Wants=network-online.target' ''
      printf '%s\n' '[Service]' 'Type=simple' "User=$user" "WorkingDirectory=$state/app" "$path_line" "ExecStart=$exec_start"
      printf '%s\n' 'Restart=always' 'RestartSec=5' ''
      printf '%s\n' '[Install]' 'WantedBy=multi-user.target'
    } > "$state/$unit"
    $sudo install -m 644 "$state/$unit" "/etc/systemd/system/$unit"
    rm -f "$state/$unit"
    $sudo systemctl daemon-reload
    $sudo systemctl enable "$unit" > /dev/null 2>&1
    $sudo systemctl restart "$unit"
    printf 'systemd-system %s\n' "$unit" > "$state/autostart"
    say "Системная служба $unit (запускается при загрузке)."
    return 0
  fi
  local udir="$HOME/.config/systemd/user" unit="agent-hub-agent.service"
  mkdir -p "$udir"
  {
    printf '%s\n' "# Agent Hub agent (installed by $state; remove: $state/uninstall.sh)."
    printf '%s\n' '[Unit]' 'Description=Agent Hub agent' 'After=network-online.target' ''
    printf '%s\n' '[Service]' 'Type=simple' "WorkingDirectory=$state/app" "$path_line" "ExecStart=$exec_start"
    printf '%s\n' 'Restart=always' 'RestartSec=5' ''
    printf '%s\n' '[Install]' 'WantedBy=default.target'
  } > "$udir/$unit"
  if ! systemctl --user daemon-reload 2> /dev/null; then
    printf 'none\n' > "$state/autostart"
    warn "systemd --user недоступен в этом сеансе (войдите по SSH или в графический сеанс этим пользователем): автозапуск не настроен."
    AUTOSTART_STARTED=0
    return 0
  fi
  systemctl --user enable "$unit" > /dev/null 2>&1
  systemctl --user restart "$unit"
  printf 'systemd-user %s\n' "$unit" > "$state/autostart"
  say "Пользовательская служба systemd --user $unit."
  loginctl enable-linger "$user" 2> /dev/null || true
  if [[ "$(loginctl show-user "$user" -p Linger --value 2> /dev/null)" == yes ]]; then
    say "Агент работает и после перезагрузки без входа (linger)."
  else
    warn "агент работает, пока вы вошли; для работы после перезагрузки выполните sudo loginctl enable-linger $user"
  fi
  return 0
}

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<< "$1"; }

# macOS: LaunchAgent of the user (default) or LaunchDaemon with UserName (--daemon, needs sudo).
autostart_macos() {
  local state="$1" node="$2" user="$3" daemon="$4"
  local label="io.github.jonasasx.agent-hub" plist uid prev
  uid="$(id -u)"
  # stop_agent already stopped an earlier install; under another label (the label was renamed) its plist is removed below.
  prev="$(cat "$state/autostart" 2> /dev/null || echo none)"
  if [[ "$daemon" == 1 ]]; then
    plist="/Library/LaunchDaemons/$label.plist"
  else
    plist="$HOME/Library/LaunchAgents/$label.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
  fi
  cat > "$state/$label.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$node")</string>
    <string>--env-file=$(xml "$state/agent.env")</string>
    <string>$(xml "$state/app/supervisor.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$state/app")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$HOME/.local/bin:$state/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
$(if [[ "$daemon" == 1 ]]; then printf '  <key>UserName</key><string>%s</string>\n' "$(xml "$user")"; fi)
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$state/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$state/launchd.log")</string>
</dict>
</plist>
EOF
  if [[ "$daemon" == 1 ]]; then
    say "LaunchDaemon (работает без входа пользователя): нужен пароль администратора."
    sudo install -m 644 -o root -g wheel "$state/$label.plist" "$plist"
    rm -f "$state/$label.plist"
    sudo launchctl bootout "system/$label" 2> /dev/null || true
    sudo launchctl bootstrap system "$plist"
    sudo launchctl kickstart -k "system/$label"
    printf 'launchd-daemon %s\n' "$label" > "$state/autostart"
    # A LaunchAgent of an earlier install without --daemon would start a second agent at the next login.
    if [[ -f "$HOME/Library/LaunchAgents/$label.plist" ]]; then
      launchctl bootout "gui/$uid/$label" 2> /dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$label.plist"
      say "Прежний LaunchAgent $label удалён."
    fi
  else
    mv "$state/$label.plist" "$plist"
    launchctl bootout "gui/$uid/$label" 2> /dev/null || true
    launchctl bootstrap "gui/$uid" "$plist"
    launchctl kickstart -k "gui/$uid/$label"
    printf 'launchd-agent %s\n' "$label" > "$state/autostart"
  fi
  if [[ "$prev" == launchd-* && "${prev#* }" != "$label" ]]; then
    if [[ "${prev%% *}" == launchd-daemon ]]; then
      sudo rm -f "/Library/LaunchDaemons/${prev#* }.plist"
    else
      rm -f "$HOME/Library/LaunchAgents/${prev#* }.plist"
    fi
  fi
  say "Автозапуск: $plist"
}

full_disk_access_hint() {
  local node="$1"
  say ""
  say "Чтобы агент видел ~/Documents, ~/Desktop и ~/Downloads:"
  say "  Системные настройки → Конфиденциальность и безопасность → Полный доступ к диску,"
  say "  нажмите «+» и добавьте $node (Cmd+Shift+G — вставить путь)."
  say "Без этого сессии в этих папках не увидят файлы; в ~/code и других папках всё работает."
  if [[ -z "${AGENT_HUB_NO_OPEN:-}" ]]; then
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2> /dev/null || true
  fi
}

# Watches the new part of agent.log for the hub's welcome.
wait_connected() {
  local log="$1" offset="$2" secs="$3" i chunk
  say "Ждём подключения агента к хабу…"
  for ((i = 0; i < secs; i++)); do
    if [[ -f "$log" ]]; then
      chunk="$(tail -c +"$((offset + 1))" "$log" 2> /dev/null || true)"
      if grep -q '"connected to hub"' <<< "$chunk"; then
        say "Агент подключился к хабу."
        return 0
      fi
      if grep -q 'hub rejected the agent token' <<< "$chunk"; then
        warn "хаб отклонил токен агента: нажмите «Переподключить» в браузере и запустите новую команду"
        return 1
      fi
    fi
    sleep 1
  done
  warn "агент запущен, но ещё не подключился к хабу; журнал: $log"
}

main "$@"
