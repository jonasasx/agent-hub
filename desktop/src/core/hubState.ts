/**
 * Model of sessions and machines the main process keeps (design D4). Requirement: Соединение приложения с хабом.
 *
 * Seeded from `GET /api/sidebar` — the same set of sessions the web builds «Сейчас» from: `now` ∪ `projects[].sessions`
 * (web/src/features/workspace/actions.ts `loadSidebar`, Sidebar.tsx `nowList`) — and `runners`, without notifications;
 * updated by `/ws/ui` messages.
 */
import type { RunnerView, SessionView, SidebarResponse, UiServerMessage } from '@agent-hub/shared';
import { decideNotification, type NotificationSpec } from './notify.js';
import { waitingCount } from './waiting.js';

export type ApplyResult =
  | { kind: 'changed'; notification: NotificationSpec | null }
  /** `projects.changed`, or a machine came back online: re-read the sidebar (without notifications). */
  | { kind: 'reseed' }
  | { kind: 'ignored' };

export class HubState {
  readonly sessions = new Map<string, SessionView>();
  readonly runners = new Map<string, RunnerView>();

  /** Replaces the model with the sidebar; never notifies. */
  seed(sidebar: Pick<SidebarResponse, 'now' | 'runners'> & { projects?: SidebarResponse['projects'] }): void {
    this.sessions.clear();
    this.runners.clear();
    for (const r of sidebar.runners ?? []) this.runners.set(r.id, r);
    const all = [...(sidebar.now ?? []), ...(sidebar.projects ?? []).flatMap(p => p.sessions ?? [])];
    for (const s of all) this.sessions.set(s.id, s);
  }

  clear(): void {
    this.sessions.clear();
    this.runners.clear();
  }

  /**
   * Applies a server message. Unknown types and malformed payloads are ignored.
   * `windowVisibleAndFocused` is the fallback of the notification decision (D6).
   */
  handle(msg: unknown, windowVisibleAndFocused: boolean): ApplyResult {
    if (!msg || typeof msg !== 'object') return { kind: 'ignored' };
    const m = msg as UiServerMessage;
    switch (m.type) {
      case 'session.upsert': {
        const next = m.session;
        if (!next || typeof next !== 'object' || typeof next.id !== 'string') return { kind: 'ignored' };
        const prev = this.sessions.get(next.id);
        const activeVisible = typeof m.activeVisible === 'boolean' ? m.activeVisible : undefined;
        const notification = decideNotification({ prev, next, runners: this.runners, activeVisible, windowVisibleAndFocused });
        this.sessions.set(next.id, next);
        return { kind: 'changed', notification };
      }
      case 'runner.status': {
        const r = m.runner;
        if (!r || typeof r !== 'object' || typeof r.id !== 'string') return { kind: 'ignored' };
        const before = this.runners.get(r.id);
        this.runners.set(r.id, r);
        // Back online: the sidebar of an offline machine had none of its sessions in «Сейчас» — re-read it silently.
        if (r.online && !before?.online) return { kind: 'reseed' };
        return { kind: 'changed', notification: null };
      }
      case 'projects.changed':
        return { kind: 'reseed' };
      default:
        return { kind: 'ignored' };
    }
  }

  waitingCount(): number {
    return waitingCount(this.sessions.values(), this.runners);
  }
}
