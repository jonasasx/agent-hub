/**
 * Handoff prompt drafts (design.md D14 «Handoff» 1, 3): `POST …/handoff-drafts` answers 202, the text comes as WS
 * `handoff.draft`; a poll of `GET /api/handoff-drafts/:id` covers a socket that missed it. The hub gives up after
 * 120 s; the form gives up a little later on its own, so a lost answer never spins forever.
 */
import { create } from 'zustand';
import { api, type HandoffDraft } from '../../api/client';
import { hubText, t } from '../../i18n';

export const DRAFT_TIMEOUT_MS = 125_000;
const POLL_MS = 3_000;

interface DraftState {
  byId: Record<string, HandoffDraft>;
}
export const useDrafts = create<DraftState>()(() => ({ byId: {} }));

const put = (d: HandoffDraft) => {
  useDrafts.setState(st => ({ byId: { ...st.byId, [d.id]: { ...st.byId[d.id], ...d } } }));
};

/** The error of a failed draft in the interface language when the hub sent its key (the form renders it, so a language switch follows). */
export const draftError = (d: HandoffDraft): string | undefined => (d.error ? hubText(d.error, d.errorI18n) : undefined);

let gen = 0;
/** The form closed: its drafts are no longer polled. */
export function stopDraftPolling(): void {
  gen++;
}

export function draftArrived(d: HandoffDraft): void {
  put(d);
}

/**
 * Starts a draft for the session; returns its id, or throws the hub's error. Polls until ready, error or timeout.
 * `subscriptionId` — the subscription the user picked in the form (claude-subscriptions QA B1); absent — the hub's
 * choice (the default one unless it has a limit or a rejected token).
 */
export async function startDraft(sessionId: string, timeoutMs = DRAFT_TIMEOUT_MS, pollMs = POLL_MS, subscriptionId?: string): Promise<string> {
  const d = await api.createHandoffDraft(sessionId, subscriptionId);
  // the WS answer may come before this response: never overwrite it with `pending`
  if (!useDrafts.getState().byId[d.id]) put({ ...d, status: d.status ?? 'pending' });
  const started = Date.now();
  const mine = gen;
  const tick = async () => {
    if (mine !== gen) return;
    const cur = useDrafts.getState().byId[d.id];
    if (!cur || cur.status !== 'pending') return;
    if (Date.now() - started >= timeoutMs) {
      put({ id: d.id, status: 'error', error: t('sessions.fork.draft.timeout') });
      return;
    }
    try {
      const got = await api.handoffDraft(d.id);
      if (got.status !== 'pending') put(got);
    } catch {
      // the next tick tries again; the timeout ends it
    }
    setTimeout(() => void tick(), pollMs);
  };
  setTimeout(() => void tick(), pollMs);
  return d.id;
}
