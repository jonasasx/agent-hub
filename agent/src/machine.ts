// Facts about this machine for the hello message.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { AGENT_CAPABILITIES, PROTOCOL_VERSION, type PayloadOf, type AgentMessage, type ClaudeStatus, type ProtectedDirs } from '@agent-hub/shared';
import pkg from '../package.json' with { type: 'json' };

export type HelloPayload = PayloadOf<AgentMessage, 'hello'>;

export const AGENT_VERSION: string = pkg.version;

/** "Windows 11 Pro" / "Ubuntu 24.04.1 LTS" / fallback "<platform> <release>". */
export function osName(): string {
  if (process.platform === 'win32') {
    const name = os.version(); // product name from the registry, e.g. "Windows 10 Pro"
    const build = Number(os.release().split('.')[2] ?? 0);
    // Windows 11 keeps "Windows 10" in the registry product name; build 22000+ is Windows 11.
    return build >= 22000 ? name.replace(/^Windows 10\b/, 'Windows 11') : name;
  }
  if (process.platform === 'linux') {
    try {
      const m = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'));
      if (m) return m[1]!;
    } catch {
      // fall through
    }
  }
  return `${os.type()} ${os.release()}`;
}

/** Versions of the Agent SDK and of the Claude Code build bundled with it. */
export function sdkVersions(): { sdkVersion: string; claudeCodeVersion: string | null } {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const p = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string; claudeCodeVersion?: string };
    return { sdkVersion: p.version, claudeCodeVersion: p.claudeCodeVersion ?? null };
  } catch {
    return { sdkVersion: 'unknown', claudeCodeVersion: null };
  }
}

/** 1.5 (multi-user): checked at start (main.ts) and updated after an authorization failure in a turn. */
export interface MachineStatus {
  claude?: ClaudeStatus;
  protectedDirs?: ProtectedDirs;
}

/**
 * Requirement (runner-enrollment): Запуск под root. The same rule as Claude Code (isRootOutsideDeliberateSandbox): uid 0,
 * not Windows, no IS_SANDBOX=1 and no CLAUDE_CODE_BUBBLEWRAP — then it refuses bypassPermissions.
 */
export function runsAsRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): boolean {
  return platform !== 'win32' && uid === 0 && env.IS_SANDBOX !== '1' && !env.CLAUDE_CODE_BUBBLEWRAP;
}

export function buildHello(opts: { vaultRoot: string | null; status?: MachineStatus }): HelloPayload {
  return {
    protocol: PROTOCOL_VERSION,
    capabilities: [...AGENT_CAPABILITIES],
    agentVersion: AGENT_VERSION,
    ...sdkVersions(),
    hostname: os.hostname(),
    os: osName(),
    homeDir: os.homedir(),
    vaultRoot: opts.vaultRoot,
    // Live sessions (M2) and transcript files (M3) are reported by later milestones.
    liveSessions: [],
    files: [],
    // Built right before sending: the hub measures its offset to this machine's clock.
    clockMs: Date.now(),
    ...(opts.status?.claude ? { claude: opts.status.claude } : {}),
    ...(opts.status?.protectedDirs ? { protectedDirs: opts.status.protectedDirs } : {}),
    arch: process.arch,
    root: runsAsRoot(),
  };
}
