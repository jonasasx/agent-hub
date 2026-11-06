/**
 * The left panel as the phone shell and the home screen (docs/prototype.html, sidebar()): the brand, the theme, the
 * profile, the search and «Новая сессия» over the list of sessions. On the desktop the sessions are a tool window
 * (`SessionsWindow`) and the app has icon rails instead of this panel; the phone shows the other windows from the
 * «☰» drawer.
 * Requirements (workspace-ui): Раздел «Сейчас»; Дерево «Проекты»; Быстрый поиск Ctrl+K (button); Темы; Телефонный режим.
 */
import { useState } from 'react';
import { useStore } from '../../store';
import { applyTheme, currentTheme } from '../theme/theme';
import { PhoneDrawer } from '../toolwindows/PhoneDrawer';
import { ProfileMenu } from './ProfileMenu';
import { SessionsList, SkeletonRows } from './SessionsList';
import { useT } from '../../i18n';

export { SkeletonRows };

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const [theme, setTheme] = useState(currentTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };
  return (
    <aside className="side" aria-label={t('workspace.sidebar.sessionsAndProjects')}>
      <div className="side-top">
        <PhoneDrawer />
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ah
          </div>
          Agent Hub
        </div>
        <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? t('workspace.theme.light') : t('workspace.theme.dark')} title={t('workspace.theme.switch')}>
          ◐
        </button>
        <ProfileMenu onLogout={onLogout} />
      </div>
      <div className="side-actions">
        <button type="button" className="search" onClick={() => useStore.setState({ modal: { type: 'search' } })}>
          <span aria-hidden="true">⌕</span>
          {t('workspace.sidebar.findSession')}
          <kbd>Ctrl K</kbd>
        </button>
        <button
          type="button"
          className="btn primary"
          title={t('workspace.sidebar.newSession')}
          aria-label={t('workspace.sidebar.newSession')}
          onClick={() => useStore.setState({ modal: { type: 'new' } })}
        >
          ＋
        </button>
      </div>
      <SessionsList />
    </aside>
  );
}
