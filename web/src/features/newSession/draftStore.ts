/**
 * The launch choices of new-session draft tabs (change new-session-draft-tab): kept by draft id outside React, because
 * the workspace renders only the active tab and a draft must survive switching tabs. The text lives in `st.drafts`,
 * the attachments in `useAttachments`, both by the same id.
 */
import { create } from 'zustand';
import type { Provider, UiPermissionMode, UserProjectView } from '../../api/types';

/** The chip an error belongs to; `form` — only the banner. */
export type DraftField = 'runner' | 'project' | 'model' | 'subscription' | 'form';

export interface Draft {
  /** '' — the first online machine. */
  runnerId: string;
  provider: Provider;
  /** 'auto' — the hub detects it from the message, 'none' — pinned without a project after the launch. */
  project: string;
  /** The name of the chosen project (a project created in the chip is not in the loaded lists yet). */
  projectTitle: string;
  /** null — the default of the machine (bypassPermissions, acceptEdits under root). */
  mode: UiPermissionMode | null;
  /** '' — the first model of the agent. */
  model: string;
  /** session-effort: '' — the default of the model. */
  effort: string;
  /** The subscription the user picked in this draft. */
  subPicked: string | null;
  /** The id the hub refused with 422 subscription_unavailable, until the user picks again. */
  subUnavailable?: string;
  /** The user chose the machine or the agent himself: `launchPreferences` arriving later do not override it. */
  touched: { runner: boolean; provider: boolean };
  error: { field: DraftField; message: string } | null;
  canRetry: boolean;
  busy: boolean;
}

export function newDraft(runnerId = ''): Draft {
  return {
    runnerId,
    provider: 'claude',
    project: 'auto',
    projectTitle: '',
    mode: null,
    model: '',
    effort: '',
    subPicked: null,
    touched: { runner: !!runnerId, provider: false },
    error: null,
    canRetry: false,
    busy: false,
  };
}

interface DraftsState {
  byId: Record<string, Draft>;
  /** The catalogue for the project chip, by last event; null — not loaded yet. */
  projects: UserProjectView[] | null;
}

export const useDrafts = create<DraftsState>(() => ({ byId: {}, projects: null }));

export function patchDraft(id: string, patch: Partial<Draft>): void {
  const cur = useDrafts.getState().byId[id];
  if (!cur) return;
  useDrafts.setState(s => ({ byId: { ...s.byId, [id]: { ...cur, ...patch } } }));
}

/** A choice of the user: the error of that chip is cleared. */
export function chooseInDraft(id: string, field: DraftField, patch: Partial<Draft>): void {
  const cur = useDrafts.getState().byId[id];
  if (!cur) return;
  const error = cur.error?.field === field ? null : cur.error;
  patchDraft(id, { ...patch, error, canRetry: error ? cur.canRetry : false });
}

export function dropDraft(id: string): void {
  if (!useDrafts.getState().byId[id]) return;
  useDrafts.setState(s => {
    const byId = { ...s.byId };
    delete byId[id];
    return { byId };
  });
}
