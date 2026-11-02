/**
 * The phone «назад» (≤760 px): the chat over the list is a history entry, so the system back button returns to the
 * list instead of leaving the app. Requirement (workspace-ui): Телефонный режим — «←» and «назад» lead to the list.
 * - entering the chat (list, Ctrl+K, a toast, a notification, `/s/<id>`) pushes one entry `{ahView: 'chat', sid}`;
 *   switching chats while in the chat replaces it, so «назад» does not page through chats;
 * - `popstate` onto an entry that is not the chat shows the list; the lightbox puts its own entry over the chat
 *   (ImagePreview), so the first «назад» closes it and the next one shows the list;
 * - «←» goes back when the top entry is ours, otherwise just shows the list.
 */
import { useStore } from '../../store';

type ChatEntry = { ahView: 'chat'; sid: string | null; lightbox?: boolean };

const isChat = (st: unknown): st is ChatEntry => !!st && typeof st === 'object' && (st as { ahView?: unknown }).ahView === 'chat';

function activeSid(): string | null {
  const { ws } = useStore.getState();
  return ws.panes[ws.focus]?.active ?? null;
}

let fromPop = false;
/**
 * The sids of our chat entries, bottom to top (kept with the history): a subagent's chat is pushed over the chat it
 * was opened from (a nested subagent over its parent subagent), and going to the chat right below (the parent from the
 * subagent's banner) goes back instead of adding a duplicate entry (review of subagents web).
 */
let stack: (string | null)[] = [];

/** «←» in the phone top bar. */
export function backToList(): void {
  if (isChat(history.state) && !history.state.lightbox) history.back();
  else useStore.setState({ inChat: false });
}

/** Starts following the chat state of the phone; returns the cleanup. */
export function startPhoneHistory(): () => void {
  // a reload on the chat entry starts on the list: the stale entry becomes the list again
  if (isChat(history.state)) history.replaceState(null, '', location.href);
  const unsub = useStore.subscribe((s, prev) => {
    if (fromPop || s.device !== 'phone') return;
    const sid = activeSid();
    if (s.inChat && !prev.inChat) {
      if (isChat(history.state)) history.replaceState({ ahView: 'chat', sid }, '', location.href);
      else history.pushState({ ahView: 'chat', sid }, '', location.href);
      stack = [sid];
    } else if (s.inChat && s.ws !== prev.ws && isChat(history.state) && !history.state.lightbox && history.state.sid !== sid) {
      if (stack.length > 1 && stack[stack.length - 2] === sid) {
        // back to the chat right below (the parent from a subagent's banner): no second entry for it
        stack.pop();
        fromPop = true;
        history.back();
        queueMicrotask(() => (fromPop = false));
      } else if (sid && s.tabKinds[sid] === 'subagent') {
        // a subagent's chat opens over the chat it came from — a session or a parent subagent (change `subagents`)
        history.pushState({ ahView: 'chat', sid }, '', location.href);
        stack.push(sid);
      } else {
        // switching between sessions replaces the entry
        history.replaceState({ ahView: 'chat', sid }, '', location.href);
        if (stack.length) stack[stack.length - 1] = sid;
        else stack = [sid];
      }
    } else if (!s.inChat && prev.inChat && isChat(history.state) && !history.state.lightbox) {
      // the list was shown by other means (the session went away): drop our entry so «назад» does not reopen it
      stack = [];
      fromPop = true;
      history.back();
      queueMicrotask(() => (fromPop = false));
    }
  });
  const onPop = (e: PopStateEvent) => {
    if (useStore.getState().device !== 'phone') return;
    fromPop = true;
    try {
      if (isChat(e.state)) {
        if (!e.state.lightbox) {
          const at = stack.lastIndexOf(e.state.sid);
          stack = at >= 0 ? stack.slice(0, at + 1) : [e.state.sid];
        }
        if (!useStore.getState().inChat && !e.state.lightbox) useStore.setState({ inChat: true });
        // back from a subagent's chat: the parent's chat again
        const want = e.state.sid;
        const { ws } = useStore.getState();
        if (want && !e.state.lightbox && activeSid() !== want) {
          const pane = Object.values(ws.panes).find(p => p.tabs.includes(want));
          if (pane) useStore.setState({ ws: { ...ws, focus: pane.id, panes: { ...ws.panes, [pane.id]: { ...pane, active: want } } } });
        }
      } else {
        stack = [];
        if (useStore.getState().inChat) useStore.setState({ inChat: false });
      }
    } finally {
      fromPop = false;
    }
  };
  window.addEventListener('popstate', onPop);
  return () => {
    unsub();
    window.removeEventListener('popstate', onPop);
  };
}
