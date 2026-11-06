/** The body of the «Сессии» window: the machine filter chip, «Сейчас» and «Проекты» (the former contents of the left panel). */
import { SessionsList } from './SessionsList';

export function SessionsWindow() {
  return (
    <aside className="tw-sess" aria-label="Сессии и проекты">
      <SessionsList />
    </aside>
  );
}
