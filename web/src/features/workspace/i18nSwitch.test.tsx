// Language switch without a reload (change i18n, workspace slice): the shell, the sidebar, the tool windows and the
// profile menu turn English at once and carry no Russian text; the language goes back to ru after the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunnerView, SidebarResponse } from '../../api/types';
import { App } from '../../App';
import { chooseLocale, initLocale } from '../../i18n';
import { useStore } from '../../store';

const runner = (over: Partial<RunnerView>): RunnerView => ({
  id: 'x1',
  name: 'X1',
  kind: 'machine',
  os: 'Windows 11 Pro',
  online: true,
  lastSeenAt: new Date().toISOString(),
  agentVersion: '0.1.0',
  claudeVersion: '2.1.310',
  protocolVersion: '1.0',
  incompatible: false,
  defaultDir: null,
  homeDir: null,
  ...over,
});

const sidebar: SidebarResponse = { now: [], projects: [], runners: [runner({}), runner({ id: 'hp', name: 'HP', online: false })] };

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
  send() {}
}

const CYRILLIC = /[А-Яа-яЁё]/;

/** Every visible text and accessible name of the page, as one string. */
function pageText(): string {
  const parts: string[] = [document.body.textContent ?? ''];
  for (const el of document.body.querySelectorAll('[aria-label], [title], [placeholder], [data-tip]')) {
    for (const a of ['aria-label', 'title', 'placeholder', 'data-tip']) {
      const v = el.getAttribute(a);
      if (v) parts.push(v);
    }
  }
  return parts.join('\n');
}

describe('language switch of the workspace shell', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.startsWith('/api/me') ? { user: { id: 'u1', email: 'a@b.c' }, vapidPublicKey: null } : url.startsWith('/api/sidebar') ? sidebar : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await initLocale('ru');
  });

  it('chooseLocale("en") redraws the sidebar, the tool windows and the profile menu without Cyrillic', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Профиль' })).toBeInTheDocument();
    expect(pageText()).toMatch(CYRILLIC);

    await act(async () => {
      await chooseLocale('en');
    });

    const profile = await screen.findByRole('button', { name: 'Profile' });
    expect(pageText()).not.toMatch(CYRILLIC);
    expect(screen.getByText('Nothing is waiting for an answer')).toBeInTheDocument();

    await userEvent.click(profile);
    const menu = screen.getByRole('menu', { name: 'Profile' });
    expect(menu).toBeInTheDocument();
    expect(pageText()).not.toMatch(CYRILLIC);
    await userEvent.keyboard('{Escape}');

    await act(async () => {
      await chooseLocale('ru');
    });
    expect(await screen.findByRole('button', { name: 'Профиль' })).toBeInTheDocument();
  });
});
