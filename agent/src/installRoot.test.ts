// Requirement (runner-enrollment): Запуск под root — deploy/agent/install.sh under uid 0 stops before the hub is
// contacted (the code is not spent) unless --allow-root is given. Runs the real script with stub `id`, `uname`,
// `curl`, `claude`, a stub Node and a stub agent build; the stub `cli.mjs enroll` marks that the exchange was reached.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALL = fileURLToPath(new URL('../../deploy/agent/install.sh', import.meta.url));

/** Git Bash on Windows (System32\bash.exe is WSL and does not see these paths), bash elsewhere. */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (existsSync(p)) return p;
  return null;
}
const bash = findBash();

// Builds the stubs in <work> and runs install.sh as uid 0 (fake `id`) against a fake hub.
const HARNESS = String.raw`
set -eu
W="$(cd "$1" && pwd)"; shift
INSTALL="$1"; shift
NODE_REAL="$NODE_REAL"
if command -v cygpath > /dev/null; then NODE_REAL="$(cygpath -u "$NODE_REAL")"; INSTALL="$(cygpath -u "$INSTALL")"; fi
mkdir -p "$W/bin" "$W/home" "$W/state/node/bin" "$W/state/node/lib/node_modules/npm/bin" "$W/build"
printf '#!/bin/sh\ncase "$1" in -u) echo 0 ;; -un) echo root ;; *) echo 0 ;; esac\n' > "$W/bin/id"
printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n' > "$W/bin/uname"
printf '#!/bin/sh\necho "2.1.0 (Claude Code)"\n' > "$W/bin/claude"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$NODE_REAL" > "$W/state/node/bin/node"
printf 'process.exit(0)\n' > "$W/state/node/lib/node_modules/npm/bin/npm-cli.js"
# The agent build: cli.mjs answers claude-status and marks the code exchange.
printf '' > "$W/build/agent.mjs"
printf '' > "$W/build/supervisor.mjs"
cat > "$W/build/cli.mjs" << 'EOF'
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'claude-status') console.log('{"login":"ok","version":"2.1.0"}');
if (process.argv[2] === 'enroll') { writeFileSync(process.env.ENROLL_MARK, process.argv.slice(3).join(' ')); process.exit(9); }
EOF
(cd "$W/build" && tar -czf ../agent.tgz agent.mjs supervisor.mjs cli.mjs)
SHA="$(sha256sum "$W/agent.tgz" | cut -d' ' -f1)"
printf '{"version":"9.9.9","sha256":"%s","url":"/agent/agent-9.9.9.tgz"}' "$SHA" > "$W/latest.json"
# curl: logs the URL, serves latest.json and the build; the claude installer is never needed (claude is on PATH).
cat > "$W/bin/curl" << EOF
#!/bin/sh
out=""; url=""
while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac; done
echo "\$url" >> "$W/curl.log"
case "\$url" in
  */agent/latest.json) cp "$W/latest.json" "\$out" ;;
  */agent/agent-9.9.9.tgz) cp "$W/agent.tgz" "\$out" ;;
  *) exit 7 ;;
esac
EOF
chmod 755 "$W/bin/"* "$W/state/node/bin/node"
: > "$W/curl.log"
export HOME="$W/home" AGENT_HUB_HOME="$W/state" AGENT_HUB_URL="http://hub.test" ENROLL_MARK="$W/enroll.mark" PATH="$W/bin:$PATH"
unset IS_SANDBOX CLAUDE_CODE_BUBBLEWRAP
bash "$INSTALL" "$@"
`;

describe.skipIf(!bash)('install.sh under root', () => {
  let work = '';
  afterEach(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    work = '';
  });

  function run(...args: string[]) {
    work = mkdtempSync(join(tmpdir(), 'agent-hub-install-'));
    writeFileSync(join(work, 'harness.sh'), HARNESS.replace(/\r\n/g, '\n'));
    const r = spawnSync(bash!, [join(work, 'harness.sh'), work, INSTALL, ...args], {
      env: { ...process.env, NODE_REAL: process.execPath },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const curl = existsSync(join(work, 'curl.log')) ? readFileSync(join(work, 'curl.log'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, curl, enrolled: existsSync(join(work, 'enroll.mark')) };
  }

  it('stops before the hub is contacted and explains what to do', () => {
    const r = run('CODE123');
    expect(r.status).toBe(6);
    expect(r.out).toContain('bypassPermissions');
    expect(r.out).toContain('adduser agent && su - agent');
    expect(r.out).toContain('bash -s -- CODE123');
    expect(r.out).toContain('--allow-root');
    expect(r.curl).toBe('');
    expect(r.enrolled).toBe(false);
  });

  it('goes on to the code exchange with --allow-root', () => {
    const r = run('CODE123', '--allow-root');
    expect(r.out).toContain('агент будет работать под root');
    expect(r.curl).toContain('http://hub.test/agent/latest.json');
    expect(r.enrolled).toBe(true);
    // the stub exchange fails with 9: the script stops there with its code
    expect(r.status).toBe(9);
  });
});
