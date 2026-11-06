// Component tests of the «Файлы» window and the phone rules of its styles. Requirements (file-explorer): «↑» неактивна на домашней папке; Телефон.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { resetStore, runner, session } from '../../test/factories';
import { emptyWorkspace } from '../layout/layout';
import { FilesWindow } from './FilesWindow';
import { resetFiles, useFiles } from './filesStore';
import { dir, stubFs } from './testkit';

describe('FilesWindow', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
    useStore.setState({ runners: [runner({ id: 'vm', homeDir: '/home/u', protocolVersion: '1.14' })] });
    useFiles.getState().setChoice({ kind: 'machine', runnerId: 'vm' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('«Выше» is visible but disabled at the home folder of the machine', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['a.txt']) }, files: {} });
    render(<FilesWindow />);
    const up = await screen.findByRole('button', { name: 'Выше' });
    expect(up).toBeDisabled();
    expect(up).toHaveAttribute('aria-disabled', 'true');
  });

  it('without an active session the «Сессия» chip is shown dimmed and disabled, the source is the machine', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['a.txt']) }, files: {} });
    render(<FilesWindow />);
    const chip = await screen.findByRole('button', { name: 'Сессия' });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAttribute('title', 'нет активной сессии');
    expect(chip).toHaveClass('off');
    expect(screen.getByRole('button', { name: /vm|X1|Машина/i, pressed: true })).toBeInTheDocument();
  });

  it('in the session mode with a way up «Выше» is enabled and lifts the root', async () => {
    const s = session({ runnerId: 'vm', cwd: '/home/u/proj/sub' });
    useStore.setState({ sessions: { [s.id]: s }, ws: emptyWorkspace([s.id]) });
    useFiles.getState().setChoice({ kind: 'session' });
    stubFs({ list: { '/home/u/proj/sub': dir('/home/u/proj/sub', ['a.txt']), '/home/u/proj': dir('/home/u/proj', ['sub']) }, files: {} });
    render(<FilesWindow />);
    const up = await screen.findByRole('button', { name: 'Выше' });
    expect(up).toBeEnabled();
    await userEvent.click(up);
    expect(useFiles.getState().rootUp[`session:${s.id}`]).toBe('/home/u/proj');
  });

  it('a session lifted to the home folder has «Выше» disabled', async () => {
    const s = session({ runnerId: 'vm', cwd: '/home/u/proj' });
    useStore.setState({ sessions: { [s.id]: s }, ws: emptyWorkspace([s.id]) });
    useFiles.getState().setChoice({ kind: 'session' });
    useFiles.setState({ rootUp: { [`session:${s.id}`]: '/home/u' } });
    stubFs({ list: { '/home/u': dir('/home/u', ['proj']) }, files: {} });
    render(<FilesWindow />);
    expect(await screen.findByRole('button', { name: 'Выше' })).toBeDisabled();
  });
});

describe('phone rules of the file explorer styles', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/files.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));

  it('crumbs and buttons have a hit area of 40 px', () => {
    expect(phone).toMatch(/\.fx-crumbs button \{[^}]*min-height: 40px/);
    expect(phone).toMatch(/\.fx-crumbs button \{[^}]*min-width: 40px/);
    expect(phone).toMatch(/\.fx-panel \.btn\.sm, \.fx-viewer \.btn\.sm \{[^}]*height: 40px/);
    expect(phone).toMatch(/\.fx-chip \{[^}]*min-height: 40px/);
  });
});
