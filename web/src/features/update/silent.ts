/**
 * «Скрыто и потерять нечего» (design D4): the page reloads by itself only while hidden and with no input a reload
 * would lose. ANY NEW UNSAVED INPUT GOES HERE — into `unsavedReasons` — or a silent reload will lose it.
 */
import { useStore } from '../../store';
import { useAttachments } from '../images/attachments';
import { useVoice } from '../voice/voice';
import { useUnsaved } from './unsaved';

export type UnsavedReason = 'draft' | 'attachments' | 'unconfirmed' | 'voice' | 'modal' | 'tokenForm' | 'resume' | 'switch' | 'form';

/** What would be lost now, one entry per condition of D4 (empty — nothing). */
export function unsavedReasons(): UnsavedReason[] {
  const s = useStore.getState();
  const a = useAttachments.getState();
  const out: UnsavedReason[] = [];
  if (Object.values(s.drafts).some(t => (t ?? '').trim() !== '')) out.push('draft');
  if (Object.values(a.byKey).some(l => l && l.length > 0)) out.push('attachments');
  if (Object.values(a.optimistic).some(l => l && l.length > 0)) out.push('unconfirmed');
  if (useVoice.getState().active !== null) out.push('voice');
  if (s.modal !== null) out.push('modal');
  if (s.settingsTokenFor !== null) out.push('tokenForm');
  if (Object.values(s.pendingResume).some(p => p !== undefined)) out.push('resume');
  if (s.pendingSwitch !== null) out.push('switch');
  if (Object.keys(useUnsaved.getState().keys).length > 0) out.push('form');
  return out;
}

export const hasUnsavedInput = (): boolean => unsavedReasons().length > 0;

/** D4: hidden and nothing to lose. */
export function canReloadSilently(): boolean {
  return document.visibilityState === 'hidden' && !hasUnsavedInput();
}

/** The same check as a hook for the banner's «Черновик пропадёт» (re-renders when any input store changes). */
export function useHasUnsavedInput(): boolean {
  useStore(s => s.drafts);
  useStore(s => s.modal);
  useStore(s => s.settingsTokenFor);
  useStore(s => s.pendingResume);
  useStore(s => s.pendingSwitch);
  useAttachments(s => s.byKey);
  useAttachments(s => s.optimistic);
  useVoice(s => s.active);
  useUnsaved(s => s.keys);
  return hasUnsavedInput();
}
