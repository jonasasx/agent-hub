/**
 * Pages of «Настройки» by group (change profile-menu-grouping, spec settings-navigation): the navigation column on the
 * desktop, the root list on the phone, the counter of «Все настройки» in the profile menu and Ctrl K «>».
 */
import type { ReactNode } from 'react';
import type { MessageKey } from '@agent-hub/shared';
import type { SettingsTab } from '../../store';
import { profileIcon, railIcon } from '../toolwindows/icons';

/** A real page: every `SettingsTab` except the phone root list. */
export type SettingsPage = Exclude<SettingsTab, 'index'>;

export interface PageDef {
  id: SettingsPage;
  label: MessageKey;
  admin?: boolean;
  subs?: boolean;
  desktop?: boolean;
}

export interface PageGroup {
  id: 'infra' | 'prefs' | 'account' | 'admin';
  label: MessageKey;
  pages: PageDef[];
}

export const SETTINGS_GROUPS: PageGroup[] = [
  {
    id: 'infra',
    label: 'settings.group.infra',
    pages: [
      { id: 'machines', label: 'settings.tab.machines' },
      { id: 'subscriptions', label: 'settings.tab.subscriptions', subs: true },
      { id: 'usage', label: 'settings.tab.usage', subs: true },
    ],
  },
  {
    id: 'prefs',
    label: 'settings.group.prefs',
    pages: [
      { id: 'sessions', label: 'settings.tab.sessions' },
      { id: 'notifications', label: 'settings.tab.notifications' },
      { id: 'language', label: 'settings.tab.language' },
    ],
  },
  {
    id: 'account',
    label: 'settings.group.account',
    pages: [
      { id: 'security', label: 'settings.tab.security' },
      { id: 'desktop', label: 'settings.tab.desktop', desktop: true },
    ],
  },
  {
    id: 'admin',
    label: 'settings.group.admin',
    pages: [{ id: 'users', label: 'settings.tab.users', admin: true }],
  },
];

export const ALL_PAGES: PageDef[] = SETTINGS_GROUPS.flatMap(g => g.pages);

export interface PageAccess {
  isAdmin: boolean;
  hasSubs: boolean;
  hasDesktop: boolean;
}

const allowed = (p: PageDef, a: PageAccess) => (!p.admin || a.isAdmin) && (!p.subs || a.hasSubs) && (!p.desktop || a.hasDesktop);

/** Groups with only the pages the user may open; a group left without pages is dropped. */
export function availableGroups(a: PageAccess): PageGroup[] {
  return SETTINGS_GROUPS.map(g => ({ ...g, pages: g.pages.filter(p => allowed(p, a)) })).filter(g => g.pages.length > 0);
}

export function availablePages(a: PageAccess): PageDef[] {
  return ALL_PAGES.filter(p => allowed(p, a));
}

const ICONS: Record<SettingsPage, () => ReactNode> = {
  machines: () => railIcon('machines'),
  subscriptions: () => railIcon('subs'),
  usage: () => profileIcon('usage'),
  sessions: () => profileIcon('clock'),
  notifications: () => profileIcon('bell'),
  language: () => profileIcon('globe'),
  security: () => profileIcon('shield'),
  desktop: () => profileIcon('download'),
  users: () => profileIcon('users'),
};

export const pageIcon = (id: SettingsPage): ReactNode => ICONS[id]();
