// change client-versions D4: every condition of «скрыто и потерять нечего» on its own, and the spec scenarios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo } from './buildInfo';
import { canReloadSilently, hasUnsavedInput, unsavedReasons } from './silent';
import { setUnsaved, useUnsaved } from './unsaved';
import { resetUpdateForTests, trySilent, useUpdate } from './check';
import { nav, resetSwForTests } from './sw';
import { useStore } from '../../store';
import { useAttachments } from '../images/attachments';
import { useVoice } from '../voice/voice';
import { resetStore } from '../../test/factories';

const A: BuildInfo = { version: '0.1.0', commit: 'aaaaaaa', builtAt: '2026-10-28T04:00:00Z' };
const B: BuildInfo = { version: '0.1.0', commit: 'bbbbbbb', builtAt: '2026-10-28T05:00:00Z' };

const hide = (v: 'hidden' | 'visible' = 'hidden') => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
let reload: ReturnType<typeof vi.fn>;
const realReload = nav.reload;

beforeEach(() => {
  resetStore();
  useVoice.setState({ active: null, note: {} });
  useUnsaved.setState({ keys: {} });
  resetSwForTests();
  resetUpdateForTests(A);
  reload = vi.fn();
  nav.reload = reload as unknown as () => void;
  hide('hidden');
});
afterEach(() => {
  nav.reload = realReload;
  Reflect.deleteProperty(document, 'visibilityState');
});

const attachment = { id: 'a1', name: 'x.png', url: 'blob:x', status: 'uploading' as const, progress: 10 };

describe('canReloadSilently — each condition of D4', () => {
  it('hidden and nothing to lose — yes', () => {
    expect(unsavedReasons()).toEqual([]);
    expect(canReloadSilently()).toBe(true);
  });

  const cases: [string, () => void, string][] = [
    ['a draft with text', () => useStore.setState({ drafts: { s1: 'недописано' } }), 'draft'],
    ['an attachment over the composer', () => useAttachments.setState({ byKey: { s1: [attachment] } }), 'attachments'],
    ['a sent message without the hub’s line', () => useAttachments.setState({ optimistic: { s1: [{ clientUuid: 'c1', text: 'привет', images: [] }] } }), 'unconfirmed'],
    ['dictation running', () => useVoice.setState({ active: { id: 1, sessionId: 's1', paneId: 'p1', phase: 'recording', startedAt: 0, mime: 'audio/webm' } as never }), 'voice'],
    ['the new-session form', () => useStore.setState({ modal: { type: 'new' } }), 'modal'],
    ['the fork form', () => useStore.setState({ modal: { type: 'fork', sessionId: 's1' } }), 'modal'],
    ['the token form opened from a note', () => useStore.setState({ settingsTokenFor: 'sub1' }), 'tokenForm'],
    ['a resume waiting for «Продолжить всё равно»', () => useStore.setState({ pendingResume: { s1: { kind: 'wake' } } }), 'resume'],
    ['a subscription switch waiting for confirmation', () => useStore.setState({ pendingSwitch: { sessionId: 's1', subscriptionId: 'x', repeatLast: false } }), 'switch'],
    ['a session restart waiting for confirmation', () => useStore.setState({ pendingRestart: { sessionId: 's1' } }), 'restart'],
    ['input in a component (answer, rename, invite)', () => setUnsaved('k1', true), 'form'],
  ];
  for (const [name, set, reason] of cases) {
    it(`${name} — no`, () => {
      set();
      expect(unsavedReasons()).toEqual([reason]);
      expect(hasUnsavedInput()).toBe(true);
      expect(canReloadSilently()).toBe(false);
    });
  }

  it('a draft of spaces only does not count', () => {
    useStore.setState({ drafts: { s1: '  \n ' } });
    expect(canReloadSilently()).toBe(true);
  });

  it('a visible window — no, even with nothing to lose', () => {
    hide('visible');
    expect(hasUnsavedInput()).toBe(false);
    expect(canReloadSilently()).toBe(false);
  });
});

describe('spec «Тихая перезагрузка скрытого окна»', () => {
  const known = () => useUpdate.setState({ hub: B, available: true });

  it('«Окно в трее»: hidden, no input — reloads', async () => {
    known();
    expect(trySilent()).toBe(true);
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('«Скрытое окно с черновиком»: no reload, the draft stays', () => {
    known();
    useStore.setState({ drafts: { s1: 'черновик' } });
    expect(trySilent()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(useStore.getState().drafts.s1).toBe('черновик');
  });

  it('«Идёт диктовка»: no reload while it runs; its text in the draft keeps it so', () => {
    known();
    useVoice.setState({ active: { id: 1, sessionId: 's1', paneId: 'p1', phase: 'transcribing', startedAt: 0, mime: 'audio/webm' } as never });
    expect(trySilent()).toBe(false);
    useVoice.setState({ active: null });
    useStore.setState({ drafts: { s1: 'Привет из диктовки' } });
    expect(trySilent()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('«Видимое окно»: no reload', () => {
    known();
    hide('visible');
    expect(trySilent()).toBe(false);
  });

  it('no new build known — nothing to do', () => {
    expect(trySilent()).toBe(false);
  });
});
