/** The source of the «Файлы» window as a hook: it follows the active session, the chosen chip and the machine list. */
import { useMemo } from 'react';
import { useStore } from '../../store';
import { lastActiveSession, useFiles } from './filesStore';
import { resolveSource, type Source } from './source';

export function useSource(): Source | null {
  const ws = useStore(s => s.ws);
  const openedAt = useStore(s => s.openedAt);
  const tabKinds = useStore(s => s.tabKinds);
  const sessions = useStore(s => s.sessions);
  const runners = useStore(s => s.runners);
  const choice = useFiles(s => s.choice);
  const rootUp = useFiles(s => s.rootUp);
  const outdated = useFiles(s => s.outdated);
  return useMemo(
    () => resolveSource({ choice, sessionId: lastActiveSession(ws, openedAt, tabKinds, sessions), sessions, runners, rootUp, outdated }),
    [choice, ws, openedAt, tabKinds, sessions, runners, rootUp, outdated],
  );
}

/** The session of the window for «@ В сообщение» and the chip: the last active session. */
export function useLastSessionId(): string | null {
  const ws = useStore(s => s.ws);
  const openedAt = useStore(s => s.openedAt);
  const tabKinds = useStore(s => s.tabKinds);
  const sessions = useStore(s => s.sessions);
  return useMemo(() => lastActiveSession(ws, openedAt, tabKinds, sessions), [ws, openedAt, tabKinds, sessions]);
}
