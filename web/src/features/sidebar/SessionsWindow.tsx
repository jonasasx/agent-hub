/** The body of the «Сессии» window: the machine filter chip, «Сейчас» and «Проекты» (the former contents of the left panel). */
import { SessionsList } from './SessionsList';
import { useT } from '../../i18n';

export function SessionsWindow() {
  const t = useT();
  return (
    <aside className="tw-sess" aria-label={t('workspace.sidebar.sessionsAndProjects')}>
      <SessionsList />
    </aside>
  );
}
