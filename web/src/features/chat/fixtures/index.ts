// Real `.jsonl` lines (Claude Code 2.1.29x sessions on HP; thinking signatures removed as the hub does, D4) as hub events.
import raw from './real-session.jsonl?raw';
import type { HubEvent } from '../../../api/types';

export function fixtureEvents(): HubEvent[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l, n) => {
      const line = JSON.parse(l) as Record<string, unknown>;
      return { kind: 'line', id: `l:1:0:${n}`, ts: String(line.timestamp ?? '2026-10-25T05:00:00Z'), line };
    });
}
