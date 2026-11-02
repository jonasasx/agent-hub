// Source of a session (design D5), checked top to bottom: hub → Orca → desktop/SDK → terminal → cron → Drive import.
// Signals come from the main transcript only (subagents write sdk-cli lines with turnOrigin = sdk whatever the
// session is). A session with a human reply is never cron. Remote Control is a flag, not a source.
// Requirement: Метаданные сессии из реплики.
import type { RunnerPlatform, SessionSource } from '@agent-hub/shared';

export interface SourceSignals {
  isHubManaged: boolean;
  cronMarker: boolean;
  cwd: string | null;
  /** Some line has entrypoint = cli. */
  seenCli: boolean;
  /** Some line has entrypoint = sdk-cli. */
  seenSdkCli: boolean;
  /** Some user line has turnOrigin = human or origin.kind = human. */
  seenHuman: boolean;
  /** Such a human line without entrypoint = cli (desktop app, SDK clients). */
  seenHumanNonCli: boolean;
  /** Platform of the runner (runners.home_dir): desktop on Windows, SDK on Linux. */
  platform: RunnerPlatform | null;
  /** Created by the Drive import and never seen in live replication. */
  driveImport?: boolean;
}

/** Orca worktrees: `…\orca\workspaces\…` on disk (encoded as `orca-workspaces` in the project dir), or orca-sandbox. */
export function isOrcaCwd(cwd: string | null): boolean {
  return !!cwd && /orca[-\\/](workspaces|sandbox)/i.test(cwd);
}

export function sessionSource(s: SourceSignals): SessionSource {
  if (s.isHubManaged) return 'hub';
  if (isOrcaCwd(s.cwd)) return 'orca';
  if (s.seenHumanNonCli) return s.platform === 'linux' ? 'sdk' : 'desktop';
  if (s.seenCli) return 'terminal';
  // No human reply left to explain the session: a cron run (by marker or by the sdk-cli-only heuristic) — also when it
  // came from the Drive import (review M3c: the import does not bypass D5).
  if (!s.seenHuman) return 'cron';
  if (s.driveImport) return 'drive_import';
  return s.platform === 'linux' ? 'sdk' : 'desktop';
}

/** What one transcript line tells about the source. */
export function lineSignals(line: Record<string, unknown>): { cli: boolean; sdkCli: boolean; human: boolean; humanNonCli: boolean; remoteControl: boolean } {
  const origin = line.origin as { kind?: unknown } | undefined;
  const human = line.type === 'user' && line.isMeta !== true && (line.turnOrigin === 'human' || origin?.kind === 'human');
  return {
    cli: line.entrypoint === 'cli',
    sdkCli: line.entrypoint === 'sdk-cli',
    human,
    humanNonCli: human && line.entrypoint !== 'cli',
    remoteControl: line.type === 'bridge-session',
  };
}
