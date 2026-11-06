/**
 * Whether the app runs in the phone layout (≤760 px, `PHONE_QUERY`). The media query decides when the browser has one;
 * without `matchMedia` (jsdom) the device of the store does. The tool windows go to a drawer there (spec «Телефон»).
 */
import { useSyncExternalStore } from 'react';
import { PHONE_QUERY } from '../workspace/actions';
import { useStore } from '../../store';

const query = () => (typeof window !== 'undefined' ? window.matchMedia?.(PHONE_QUERY) : undefined);

function subscribe(cb: () => void): () => void {
  const mq = query();
  mq?.addEventListener?.('change', cb);
  return () => mq?.removeEventListener?.('change', cb);
}

/** 0 — wide, 1 — narrow, 2 — the browser cannot tell. */
function snapshot(): 0 | 1 | 2 {
  const mq = query();
  if (!mq) return 2;
  return mq.matches ? 1 : 0;
}

export function usePhone(): boolean {
  const media = useSyncExternalStore(subscribe, snapshot, () => 2);
  const device = useStore(s => s.device);
  return media === 2 ? device === 'phone' : media === 1;
}

/** The same outside of a component. */
export function isPhoneNow(): boolean {
  const media = snapshot();
  return media === 2 ? useStore.getState().device === 'phone' : media === 1;
}
