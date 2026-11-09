/**
 * The name of a tab, shared by the tab itself and the list of all tabs of a pane (spec tab-strip: Список всех вкладок
 * панели): a session title, «Субагент · <описание>» for a subagent, the file name for a file tab (with the folder name
 * when two open files share a name).
 */
import { useStore } from '../../store';
import { parseFileTabId } from '../layout/layout';
import { baseName, parentOf } from '../files/paths';
import { subTitle } from '../subagents/model';
import { colorVar } from '../sessions/status';
import { useT } from '../../i18n';

type State = ReturnType<typeof useStore.getState>;
type Translator = ReturnType<typeof useT>;

export function tabTitle(st: State, sid: string, t: Translator): string {
  const file = parseFileTabId(sid);
  if (file) return baseName(file.path);
  if (st.tabKinds[sid] === 'subagent') {
    const sub = st.subagents[sid];
    return sub ? t('workspace.panes.subagentTitle', { title: subTitle(sub) }) : t('workspace.panes.subagentLoading');
  }
  return st.sessions[sid]?.title ?? t('workspace.panes.loading');
}

/** The folder of a file tab when another open file has the same name, otherwise ''. */
export function tabFileHint(st: State, sid: string): string {
  const file = parseFileTabId(sid);
  if (!file) return '';
  const name = baseName(file.path);
  const same = Object.values(st.ws.panes).some(p => p.tabs.some(tab => tab !== sid && baseName(parseFileTabId(tab)?.path ?? '') === name));
  return same ? baseName(parentOf(file.path) ?? '') : '';
}

export function useTabTitle(sid: string): { title: string; fileHint: string; colorKey: Parameters<typeof colorVar>[0] } {
  const t = useT();
  const title = useStore(st => tabTitle(st, sid, t));
  const fileHint = useStore(st => tabFileHint(st, sid));
  const colorKey = useStore(st => {
    const sub = st.tabKinds[sid] ? st.subagents[sid] : undefined;
    // a subagent tab takes its parent's project colour
    return (st.sessions[sid] ?? (sub ? st.sessions[sub.sessionId] : undefined))?.project.colorKey;
  });
  return { title, fileHint, colorKey };
}
