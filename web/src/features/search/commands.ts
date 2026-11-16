/**
 * Ctrl K «>» (change profile-menu-grouping, spec workspace-ui «Команды в быстром поиске»): local commands without a
 * request to the hub — the settings pages, single settings by the page they live on, and actions. A row says its kind;
 * a setting also names its page.
 */
import type { MessageKey } from '@agent-hub/shared';
import { t } from '../../i18n';
import { availablePages, type PageAccess, type SettingsPage } from '../settings/pages';

export type CommandKind = 'page' | 'param' | 'action';
export type ActionId = 'sleep' | 'hidden' | 'reset' | 'theme';

export interface Command {
  id: string;
  kind: CommandKind;
  label: string;
  /** The page a setting lives on, shown after its label. */
  page?: string;
  /** Extra words matched by the query, not shown. */
  keywords: string;
  target: { type: 'page'; page: SettingsPage } | { type: 'action'; action: ActionId };
}

export interface CommandContext extends PageAccess {
  /** The active pane holds an awake hub session that can sleep now. */
  canSleep: boolean;
}

const PARAMS: { id: string; label: MessageKey; kw: MessageKey; page: SettingsPage; pageLabel: MessageKey }[] = [
  { id: 'idle', label: 'workspace.search.cmd.idle', kw: 'workspace.search.kw.idle', page: 'sessions', pageLabel: 'settings.tab.sessions' },
  { id: 'language', label: 'workspace.search.cmd.language', kw: 'workspace.search.kw.language', page: 'language', pageLabel: 'settings.tab.language' },
  { id: 'push', label: 'workspace.search.cmd.push', kw: 'workspace.search.kw.push', page: 'notifications', pageLabel: 'settings.tab.notifications' },
];

const ACTIONS: { id: ActionId; label: MessageKey; kw: MessageKey }[] = [
  { id: 'sleep', label: 'workspace.search.cmd.sleep', kw: 'workspace.search.kw.sleep' },
  { id: 'hidden', label: 'workspace.search.cmd.hidden', kw: 'workspace.search.kw.hidden' },
  { id: 'reset', label: 'workspace.search.cmd.reset', kw: 'workspace.search.kw.reset' },
  { id: 'theme', label: 'workspace.search.cmd.theme', kw: 'workspace.search.kw.theme' },
];

/** All commands the user may run now, in the order pages → settings → actions. */
export function buildCommands(ctx: CommandContext): Command[] {
  const pages = availablePages(ctx);
  const out: Command[] = pages.map(p => ({ id: `page:${p.id}`, kind: 'page', label: t(p.label), keywords: p.id, target: { type: 'page', page: p.id } }));
  for (const p of PARAMS) {
    if (!pages.some(x => x.id === p.page)) continue;
    out.push({ id: `param:${p.id}`, kind: 'param', label: t(p.label), page: t(p.pageLabel), keywords: t(p.kw), target: { type: 'page', page: p.page } });
  }
  for (const a of ACTIONS) {
    if (a.id === 'sleep' && !ctx.canSleep) continue;
    out.push({ id: `action:${a.id}`, kind: 'action', label: t(a.label), keywords: t(a.kw), target: { type: 'action', action: a.id } });
  }
  return out;
}

/** True when the query asks for commands: it starts with «>». */
export const isCommandQuery = (q: string): boolean => q.trimStart().startsWith('>');

/** Every word of the query after «>» is in the label, the page or the keywords, case-insensitive. */
export function filterCommands(all: Command[], q: string): Command[] {
  const words = q.trimStart().slice(1).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  return all.filter(c => {
    const hay = `${c.label} ${c.page ?? ''} ${c.keywords}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}
