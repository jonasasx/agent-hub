/**
 * Global hotkeys. Requirement (workspace-ui): Горячие клавиши — Ctrl/Cmd+1…8 (only when the tab exists; Ctrl+9 and
 * empty numbers stay with the browser), Ctrl/Cmd+\ «Одно окно»/«Вернуть разделение» (not on the phone),
 * Ctrl/Cmd+K quick search, Ctrl/Cmd+Alt+N a new-session draft, Esc closes a modal, menu or search.
 */
import { useStore } from '../../store';
import { activateByNumber, openDraft, toggleSingle } from './actions';

export function handleHotkey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'> & { code?: string }): boolean {
  const st = useStore.getState();
  if (e.key === 'Escape' && st.modal) {
    useStore.setState({ modal: null });
    e.preventDefault();
    return true;
  }
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl+Alt+N — a new-session draft (spec new-session-draft); Ctrl+N belongs to the browser
  if (mod && e.altKey && (e.key.toLowerCase() === 'n' || e.code === 'KeyN') && !st.modal) {
    e.preventDefault();
    openDraft();
    return true;
  }
  if (!mod || e.altKey) return false;
  // e.code keeps the shortcuts working on the Russian layout
  if (e.key.toLowerCase() === 'k' || e.code === 'KeyK') {
    e.preventDefault();
    useStore.setState({ modal: { type: 'search' } });
    return true;
  }
  // An open dialog (Ctrl+K, fork) owns the keyboard: the workspace shortcuts must not change the panes
  // behind it. Ctrl+K above still works (search over the other dialog), Esc closes the dialog.
  if (st.modal) return false;
  if ((e.key === '\\' || e.code === 'Backslash') && st.device !== 'phone') {
    e.preventDefault();
    toggleSingle();
    return true;
  }
  if (/^[1-8]$/.test(e.key) && activateByNumber(Number(e.key))) {
    e.preventDefault();
    return true;
  }
  return false;
}
