// D5 order of sources and the transcript path on the runner.
import { describe, expect, it } from 'vitest';
import { transcriptPath } from '../sessions/service.js';
import { isOrcaCwd, lineSignals, sessionSource, type SourceSignals } from './source.js';

const base: SourceSignals = {
  isHubManaged: false,
  cronMarker: false,
  cwd: 'C:\\Users\\alice\\vault',
  seenCli: false,
  seenSdkCli: false,
  seenHuman: false,
  seenHumanNonCli: false,
  platform: 'windows',
};

describe('sessionSource (D5)', () => {
  it.each<[string, Partial<SourceSignals>, string]>([
    ['hub first', { isHubManaged: true, cronMarker: true, seenCli: true }, 'hub'],
    ['Orca before desktop and terminal', { cwd: 'C:\\Users\\alice\\orca\\workspaces\\x', seenCli: true, seenSdkCli: true, seenHuman: true, seenHumanNonCli: true }, 'orca'],
    ['desktop: a human reply outside the CLI (Windows)', { seenSdkCli: true, seenHuman: true, seenHumanNonCli: true }, 'desktop'],
    ['a human reply without entrypoint → desktop', { seenHuman: true, seenHumanNonCli: true }, 'desktop'],
    ['the same on Linux → sdk', { seenSdkCli: true, seenHuman: true, seenHumanNonCli: true, platform: 'linux' }, 'sdk'],
    ['dd346743: cli + sdk-cli human → desktop', { seenCli: true, seenSdkCli: true, seenHuman: true, seenHumanNonCli: true }, 'desktop'],
    ['terminal (human replies in cli lines)', { seenCli: true, seenHuman: true }, 'terminal'],
    ['terminal', { seenCli: true }, 'terminal'],
    ['claude -p: sdk-cli without a human → cron', { seenSdkCli: true }, 'cron'],
    ['cron marker without a human → cron', { cronMarker: true, seenSdkCli: true }, 'cron'],
    ['a human reply is never cron, even with the marker', { cronMarker: true, seenSdkCli: true, seenHuman: true, seenHumanNonCli: true, platform: 'linux' }, 'sdk'],
    ['review M3c: a headless run from Drive is cron, not drive import', { driveImport: true, seenSdkCli: true }, 'cron'],
    ['drive import: a human, no CLI/desktop signal', { driveImport: true, seenHuman: true }, 'drive_import'],
    ['drive import does not hide the terminal', { driveImport: true, seenCli: true }, 'terminal'],
  ])('%s', (_n, s, want) => {
    expect(sessionSource({ ...base, ...s })).toBe(want);
  });

  it('Orca cwd on disk and in the encoded directory name', () => {
    expect(isOrcaCwd('C:\\Users\\alice\\orca\\workspaces\\scanner-fleet')).toBe(true);
    expect(isOrcaCwd('C:\\Users\\alice\\orca-workspaces\\x')).toBe(true);
    expect(isOrcaCwd('/home/u/orca-sandbox/a')).toBe(true);
    expect(isOrcaCwd('C:\\Users\\alice\\vault')).toBe(false);
  });

  it('line signals: entrypoint, human turn (turnOrigin or origin.kind), outside the CLI, bridge-session', () => {
    expect(lineSignals({ type: 'user', entrypoint: 'sdk-cli', turnOrigin: 'human' })).toEqual({ cli: false, sdkCli: true, human: true, humanNonCli: true, remoteControl: false });
    expect(lineSignals({ type: 'user', entrypoint: 'cli', turnOrigin: 'human' })).toMatchObject({ human: true, humanNonCli: false });
    expect(lineSignals({ type: 'user', origin: { kind: 'human' } })).toMatchObject({ human: true, humanNonCli: true });
    expect(lineSignals({ type: 'user', turnOrigin: 'sdk' }).human).toBe(false);
    expect(lineSignals({ type: 'user', turnOrigin: 'human', isMeta: true }).human).toBe(false);
    expect(lineSignals({ type: 'bridge-session' }).remoteControl).toBe(true);
  });
});

describe('transcriptPath', () => {
  it('builds the path in the runner separators', () => {
    expect(transcriptPath('C:\\Users\\alice', 'c--Users-alice-vault/a.jsonl')).toBe('C:\\Users\\alice\\.claude\\projects\\c--Users-alice-vault\\a.jsonl');
    expect(transcriptPath('/home/ubuntu/', '-home-ubuntu-vault/a.jsonl')).toBe('/home/ubuntu/.claude/projects/-home-ubuntu-vault/a.jsonl');
    expect(transcriptPath(null, 'x')).toBeNull();
  });
});
