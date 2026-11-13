/**
 * «Настройки» in place of the work area (change `multi-user`): «Машины», «Пользователи» (role admin only), «Безопасность».
 * Addresses `/settings/<tab>`; `/settings/users` for role user answers «Страница не найдена» (tasks 6.4).
 * The screen is a history entry: the browser «назад» closes it.
 * claude-subscriptions P12 (Requirement: Подписки и расход в настройках): «Подписки» and «Расход» after «Машины», for
 * every user; a hub without the subscriptions API (404) has neither, their addresses answer «Страница не найдена».
 * «Назад» from settings opened in the phone chat (the `auth` note) returns to the chat.
 */
import { useEffect } from 'react';
import type { MessageKey } from '@agent-hub/shared';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useStore, type SettingsTab } from '../../store';
import { SubscriptionsPage, UsagePage } from '../subscriptions/SubscriptionsPage';
import { DesktopPage } from './DesktopPage';
import { LanguagePage } from './LanguagePage';
import { MachinesPage } from './MachinesPage';
import { NotificationsPage } from './NotificationsPage';
import { SecurityPage } from './SecurityPage';
import { UsersPage } from './UsersPage';

const TABS: { id: SettingsTab; label: MessageKey; admin?: boolean; subs?: boolean; desktop?: boolean }[] = [
  { id: 'machines', label: 'settings.tab.machines' },
  { id: 'subscriptions', label: 'settings.tab.subscriptions', subs: true },
  { id: 'usage', label: 'settings.tab.usage', subs: true },
  { id: 'users', label: 'settings.tab.users', admin: true },
  { id: 'security', label: 'settings.tab.security' },
  { id: 'notifications', label: 'settings.tab.notifications' },
  { id: 'language', label: 'settings.tab.language' },
  { id: 'desktop', label: 'settings.tab.desktop', desktop: true },
];

type SettingsEntry = { ahSettings: SettingsTab };
const isOurs = (st: unknown): st is SettingsEntry => !!st && typeof st === 'object' && typeof (st as { ahSettings?: unknown }).ahSettings === 'string';

/** `/settings/machines` → 'machines'; anything else under /settings → 'machines'; null — not a settings address. */
export function settingsFromPath(path: string): SettingsTab | 'unknown' | null {
  const m = /^\/settings(?:\/([a-z-]*))?\/?$/.exec(path);
  if (!m) return null;
  const name = m[1] || 'machines';
  return (TABS as { id: string }[]).some(x => x.id === name) ? (name as SettingsTab) : 'unknown';
}

/** The phone view settings were opened from (the chat for the `auth` note): «Назад» and «←» go back to it. */
let returnInChat = false;

/** `opts.tokenFor` — the subscription whose token form «Подписки» opens (P12; kept in the store, not in the address). */
export function openSettings(tab: SettingsTab = 'machines', opts: { tokenFor?: string } = {}): void {
  const url = `/settings/${tab}`;
  const st = useStore.getState();
  if (!st.settings) returnInChat = st.inChat;
  if (isOurs(history.state)) history.replaceState({ ahSettings: tab }, '', url);
  else history.pushState({ ahSettings: tab }, '', url);
  useStore.setState({ settings: tab, inChat: true, settingsTokenFor: opts.tokenFor ?? null });
}

export function closeSettings(): void {
  if (isOurs(history.state) && history.length > 1) history.back();
  else history.replaceState(null, '', '/');
  useStore.setState({ settings: null, inChat: returnInChat });
  returnInChat = false;
}

/**
 * Leave «Настройки» for a session without going back in the history (mcp-management, UI review H4: «Войти» on
 * «Машины»): `history.back()` lands asynchronously and, on an entry the app opened directly, outside the app — the
 * session opened next would be undone. The settings entry becomes the work area's address.
 */
export function leaveSettingsInPlace(): void {
  history.replaceState(null, '', '/');
  useStore.setState({ settings: null, inChat: returnInChat });
  returnInChat = false;
}

export function Settings() {
  const t = useT();
  const tab = useStore(s => s.settings);
  const isAdmin = useStore(s => s.auth.kind === 'signed_in' && s.auth.me.user.role === 'admin');
  const hasSubs = useStore(s => s.subs !== null);
  const subsMissing = useStore(s => s.subsMissing);
  const desktopInfo = useStore(s => s.desktopInfo);
  const open = tab !== null;
  // desktop-download D8: asked each time settings open, a hub may get its installer after the page loaded
  useEffect(() => {
    if (!open) return;
    api.desktopInfo().then(
      info => useStore.setState({ desktopInfo: info }),
      () => useStore.setState({ desktopInfo: { available: false } }),
    );
  }, [open]);
  useEffect(() => {
    const onPop = () => {
      const target = settingsFromPath(location.pathname);
      if (!target || !isOurs(history.state)) {
        useStore.setState({ settings: null, inChat: returnInChat });
        returnInChat = false;
      } else if (target !== 'unknown') useStore.setState({ settings: target });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  if (!tab) return null;
  const isSubs = tab === 'subscriptions' || tab === 'usage';
  // hidden while the list is not loaded yet; «Страница не найдена» only once the hub said 404
  const tabs = TABS.filter(x => (!x.admin || isAdmin) && (!x.subs || hasSubs) && (!x.desktop || !!desktopInfo?.available));
  const forbidden = (tab === 'users' && !isAdmin) || (isSubs && subsMissing) || (tab === 'desktop' && desktopInfo?.available === false);
  return (
    <div className="pane settings" role="region" aria-label={t('settings.title')}>
      <div className="set-top">
        <button type="button" className="icon-btn" aria-label={t('settings.close')} title={t('settings.closeShort')} onClick={closeSettings}>
          ←
        </button>
        <h1>{t('settings.title')}</h1>
      </div>
      <nav className="set-nav" aria-label={t('settings.navLabel')}>
        {tabs.map(x => (
          <button key={x.id} type="button" className={x.id === tab ? 'on' : ''} aria-current={x.id === tab ? 'page' : undefined} onClick={() => openSettings(x.id)}>
            {t(x.label)}
          </button>
        ))}
      </nav>
      <div className="set-body">
        {forbidden ? (
          <section>
            <h2>{t('settings.notFound.title')}</h2>
            <p className="hint">{t('settings.notFound.text')}</p>
          </section>
        ) : tab === 'machines' ? (
          <MachinesPage />
        ) : tab === 'subscriptions' ? (
          <SubscriptionsPage />
        ) : tab === 'usage' ? (
          <UsagePage />
        ) : tab === 'users' ? (
          <UsersPage />
        ) : tab === 'security' ? (
          <SecurityPage />
        ) : tab === 'notifications' ? (
          <NotificationsPage />
        ) : tab === 'desktop' ? (
          <DesktopPage />
        ) : (
          <LanguagePage />
        )}
      </div>
    </div>
  );
}
