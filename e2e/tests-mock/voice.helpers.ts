// Shared steps of the dictation e2e (change voice-input, task 3.7): Chromium's fake microphone (flags in
// playwright.mock.config.ts), the mock hub's POST /api/voice/transcribe.
import { expect, type Locator, type Page } from '@playwright/test';

/** Every track `getUserMedia` handed out, to check the microphone is released (`readyState === 'ended'`). */
export async function watchTracks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tracks: MediaStreamTrack[] };
    w.__tracks = [];
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async c => {
      const s = await orig(c);
      w.__tracks.push(...s.getTracks());
      return s;
    };
  });
}

export const tracks = (page: Page) => page.evaluate(() => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.map(t => ({ kind: t.kind, state: t.readyState })));

/** All microphone tracks of the page are stopped (and there was at least one). */
export async function expectMicReleased(page: Page) {
  await expect.poll(async () => (await tracks(page)).length).toBeGreaterThan(0);
  await expect.poll(async () => (await tracks(page)).every(t => t.kind === 'audio' && t.state === 'ended')).toBe(true);
}

/** Starts a dictation in `scope` and waits for the bar with a running timer and a moving wave. */
export async function record(page: Page, scope: Locator, ms = 1200) {
  await scope.getByRole('button', { name: 'Диктовка' }).click();
  const bar = scope.getByRole('group', { name: 'Диктовка' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Готово' })).toBeFocused();
  // the fake device beeps: some bar of the wave rises above the idle height
  await expect.poll(() => bar.locator('.voice-wave i').evaluateAll(els => Math.max(...els.map(e => new DOMMatrixReadOnly(getComputedStyle(e).transform).d)))).toBeGreaterThan(0.1);
  await page.waitForTimeout(ms);
  return bar;
}
