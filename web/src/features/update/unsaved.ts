/**
 * Input that lives in a component's own state (answers to an agent's question, rename and token forms, the invite form,
 * the «Перенести в…» filter): the component registers it here while it holds something a reload would lose (design D4).
 */
import { useEffect, useId } from 'react';
import { create } from 'zustand';

export const useUnsaved = create<{ keys: Record<string, true> }>()(() => ({ keys: {} }));

export function setUnsaved(key: string, on: boolean): void {
  const keys = useUnsaved.getState().keys;
  if (on === !!keys[key]) return;
  const next = { ...keys };
  if (on) next[key] = true;
  else delete next[key];
  useUnsaved.setState({ keys: next });
}

/** While `active`, this component holds input that a reload would lose. */
export function useUnsavedInput(active: boolean): void {
  const key = useId();
  useEffect(() => {
    setUnsaved(key, active);
    return () => setUnsaved(key, false);
  }, [key, active]);
}
