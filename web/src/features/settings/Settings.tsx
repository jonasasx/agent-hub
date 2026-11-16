/**
 * «Настройки» in place of the work area (change `multi-user`): «Машины», «Пользователи» (role admin only), «Безопасность».
 * Addresses `/settings/<tab>`; `/settings/users` for role user answers «Страница не найдена» (tasks 6.4).
 * The screen is a history entry: the browser «назад» closes it.
 * claude-subscriptions P12 (Requirement: Подписки и расход в настройках): «Подписки» and «Расход» after «Машины», for
 * every user; a hub without the subscriptions API (404) has neither, their addresses answer «Страница не найдена».
 * «Назад» from settings opened in the phone chat (the `auth` note) returns to the chat.
 * profile-menu-grouping (spec settings-navigation): pages by group (`pages.ts`) — a column on the desktop, the root list
 * `/settings` on the phone; «←» of a phone page returns to the list, «←» of the list closes «Настройки».
 */
import { useEffect } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useStore, type SettingsTab } from '../../store';
import { SubscriptionsPage, UsagePage } from '../subscriptions/SubscriptionsPage';
import { usePhone } from '../toolwindows/usePhone';
import { DesktopPage } from './DesktopPage';
import { LanguagePage } from './LanguagePage';
import { MachinesPage } from './MachinesPage';
import { NotificationsPage } from './NotificationsPage';
import { ALL_PAGES, availableGroups, pageIcon, type PageGroup, type SettingsPage } from './pages';
import { SecurityPage } from './SecurityPage';
import { SessionsPage } from './SessionsPage';
import { UsersPage } from './UsersPage';

type SettingsEntry = { ahSettings: SettingsTab };
const isOurs = (st: unknown): st is SettingsEntry => !!st && typeof st === 'object' && typeof (st as { ahSettings?: unknown }).ahSettings === 'string';

/** `/settings/machines` → 'machines'; `/settings` → 'index'; an unknown page → 'unknown'; null — not a settings address. */
export function settingsFromPath(path: string): SettingsTab | 'unknown' | null {
  const m = /^\/settings(?:\/([a-z-]*))?\/?$/.exec(path);
  if (!m) return null;
  if (!m[1]) return 'index';
  return ALL_PAGES.some(x => x.id === m[1]) ? (m[1] as SettingsTab) : 'unknown';
}

/** The address of a settings tab: the root list is `/settings`. */
export const settingsUrl = (tab: SettingsTab): string => (tab === 'index' ? '/settings' : `/settings/${tab}`);

/** The phone view settings were opened from (the chat for the `auth` note): «Назад» and «←» go back to it. */
let returnInChat = false;

/** `opts.tokenFor` — the subscription whose token form «Подписки» opens (P12; kept in the store, not in the address). */
export function openSettings(tab: SettingsTab = 'machines', opts: { tokenFor?: string } = {}): void {
  const url = settingsUrl(tab);
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

/** «admin» next to the group «Администрирование». */
function GroupLabel({ group }: { group: PageGroup }) {
  const t = useT();
  return (
    <>
      {t(group.label)}
      {group.id === 'admin' && <span className="set-pill">{t('settings.adminPill')}</span>}
    </>
  );
}

export function Settings() {
  const t = useT();
  const tab = useStore(s => s.settings);
  const isAdmin = useStore(s => s.auth.kind === 'signed_in' && s.auth.me.user.role === 'admin');
  const hasSubs = useStore(s => s.subs !== null);
  const subsMissing = useStore(s => s.subsMissing);
  const desktopInfo = useStore(s => s.desktopInfo);
  const phone = usePhone();
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
  // hidden while the list is not loaded yet; «Страница не найдена» only once the hub said 404
  const groups = availableGroups({ isAdmin, hasSubs, hasDesktop: !!desktopInfo?.available });
  if (phone && tab === 'index') return <SettingsRoot groups={groups} />;
  // desktop: `/settings` shows «Машины» without changing the address
  const page: SettingsPage = tab === 'index' ? 'machines' : tab;
  const isSubs = page === 'subscriptions' || page === 'usage';
  const forbidden = (page === 'users' && !isAdmin) || (isSubs && subsMissing) || (page === 'desktop' && desktopInfo?.available === false);
  const def = ALL_PAGES.find(x => x.id === page);
  return (
    <div className="pane settings" role="region" aria-label={t('settings.title')}>
      <div className="set-top">
        {phone ? (
          <button type="button" className="icon-btn" aria-label={t('settings.back')} title={t('settings.back')} onClick={() => openSettings('index')}>
            ←
          </button>
        ) : (
          <button type="button" className="icon-btn" aria-label={t('settings.close')} title={t('settings.closeShort')} onClick={closeSettings}>
            ←
          </button>
        )}
        <h1>{phone && def ? t(def.label) : t('settings.title')}</h1>
      </div>
      <div className="set-main">
        {!phone && (
          <nav className="set-nav grouped" aria-label={t('settings.navLabel')}>
            {groups.map(g => (
              <div key={g.id} className="set-grp" role="group" aria-labelledby={`set-grp-${g.id}`}>
                <div className="set-grp-h" id={`set-grp-${g.id}`}>
                  <GroupLabel group={g} />
                </div>
                {g.pages.map(x => (
                  <button key={x.id} type="button" className={x.id === page ? 'on' : ''} aria-current={x.id === page ? 'page' : undefined} onClick={() => openSettings(x.id)}>
                    <span className="set-ic" aria-hidden="true">
                      {pageIcon(x.id)}
                    </span>
                    {t(x.label)}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div className="set-body">
          {forbidden ? (
            <section>
              <h2>{t('settings.notFound.title')}</h2>
              <p className="hint">{t('settings.notFound.text')}</p>
            </section>
          ) : page === 'machines' ? (
            <MachinesPage />
          ) : page === 'subscriptions' ? (
            <SubscriptionsPage />
          ) : page === 'usage' ? (
            <UsagePage />
          ) : page === 'users' ? (
            <UsersPage />
          ) : page === 'security' ? (
            <SecurityPage />
          ) : page === 'notifications' ? (
            <NotificationsPage />
          ) : page === 'sessions' ? (
            <SessionsPage />
          ) : page === 'desktop' ? (
            <DesktopPage />
          ) : (
            <LanguagePage />
          )}
        </div>
      </div>
    </div>
  );
}

/** The phone root list `/settings`: groups and rows of pages; «←» closes «Настройки». */
function SettingsRoot({ groups }: { groups: PageGroup[] }) {
  const t = useT();
  return (
    <div className="pane settings" role="region" aria-label={t('settings.title')}>
      <div className="set-top">
        <button type="button" className="icon-btn" aria-label={t('settings.close')} title={t('settings.closeShort')} onClick={closeSettings}>
          ←
        </button>
        <h1>{t('settings.title')}</h1>
      </div>
      <nav className="set-root" aria-label={t('settings.navLabel')}>
        {groups.map(g => (
          <section key={g.id} className="set-root-grp" aria-labelledby={`set-root-${g.id}`}>
            <h2 id={`set-root-${g.id}`}>
              <GroupLabel group={g} />
            </h2>
            <ul>
              {g.pages.map(x => (
                <li key={x.id}>
                  <button type="button" className="set-row" onClick={() => openSettings(x.id)}>
                    <span className="set-ic" aria-hidden="true">
                      {pageIcon(x.id)}
                    </span>
                    <span className="set-row-l">{t(x.label)}</span>
                    <span className="set-row-chev" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}
