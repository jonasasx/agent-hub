import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api/client';
import { HiddenProjects } from './HiddenProjects';
import { Toasts } from '../toasts/Toasts';
import { ProjectActions } from './ProjectActions';
import { mockFetch, resetStore, RUNNERS } from '../../test/factories';
import { useStore } from '../../store';
const project = { id: 'p-e', title: 'Stable', colorKey: 'rose' as const, path: '' };
const item = { id: 'p-e', name: 'Stable', colorKey: 'rose', description: 'Notes', remote: null, archived: false, lastEventAt: null, bindings: [{ runnerId: 'x1', path: 'C:\\work' }] };
beforeEach(() => {
  resetStore();
  useStore.setState({ runners: RUNNERS });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('edits metadata/color, removes a binding, and preserves the form under the picker', async () => {
  const calls = mockFetch({
    'GET /api/catalog/projects': () => ({ status: 200, body: [item] }),
    'PATCH /api/catalog/projects/p-e': () => ({ status: 200, body: { ok: true } }),
    'DELETE /api/catalog/projects/p-e/bindings/x1': () => ({ status: 200, body: { ok: true } }),
    'GET /api/sidebar': () => ({ status: 200, body: { runners: RUNNERS, now: [], projects: [] } }),
  });
  const user = userEvent.setup();
  render(<ProjectActions project={project} total={3} />);
  await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
  await user.click(screen.getByRole('menuitem', { name: 'Изменить проект' }));
  const dialog = await screen.findByRole('dialog', { name: 'Изменить проект' });
  expect(within(dialog).getAllByRole('radio')).toHaveLength(12);
  expect(within(dialog).getByLabelText('Название')).toHaveFocus();
  await user.clear(within(dialog).getByLabelText('Название'));
  await user.type(within(dialog).getByLabelText('Название'), 'Changed');
  await user.click(within(dialog).getByRole('radio', { name: 'Песочный' }));
  await user.click(within(dialog).getByRole('button', { name: 'Убрать привязку x1' }));
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  expect(calls.find(c => c.method === 'PATCH')?.body).toMatchObject({ name: 'Changed', colorKey: 'lime' });
  expect(calls.find(c => c.method === 'PATCH')?.body).toMatchObject({ bindings: [{ runnerId: 'x1', path: null }] });
});
it('cancels deletion without a request and confirms consequences for all sessions', async () => {
  const calls = mockFetch({
    'GET /api/catalog/projects': () => ({ status: 200, body: [item] }),
    'DELETE /api/catalog/projects/p-e': () => ({ status: 200, body: { ok: true } }),
    'GET /api/sidebar': () => ({ status: 200, body: { runners: [], now: [], projects: [] } }),
  });
  const user = userEvent.setup();
  render(<ProjectActions project={project} total={3} />);
  async function open() {
    await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить проект' }));
    return screen.findByRole('dialog');
  }
  const dialog = await open();
  expect(dialog.textContent).toContain('Сессии (3)');
  expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus();
  await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await open();
  await user.click(screen.getByRole('button', { name: 'Удалить проект' }));
  expect(calls.some(c => c.method === 'DELETE')).toBe(true);
});

it('changes color directly from the menu in two clicks', async () => {
  const calls = mockFetch({ 'PATCH /api/catalog/projects/p-e': () => ({ status: 200 }), 'GET /api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: [] } }) });
  const user = userEvent.setup();
  render(<ProjectActions project={project} total={3} />);
  await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
  await user.click(screen.getByRole('radio', { name: 'Песочный' }));
  expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ colorKey: 'lime' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('shows loading until bindings arrive, then focuses the name', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.catalogProjects>>) => void;
  vi.spyOn(api, 'catalogProjects').mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  const user = userEvent.setup();
  render(<ProjectActions project={project} total={3} />);
  await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
  await user.click(screen.getByRole('menuitem', { name: 'Изменить проект' }));
  expect(screen.getByRole('dialog', { name: 'Загрузка проекта' })).toBeInTheDocument();
  finish([{ ...item, colorKey: 'rose' }]);
  const dialog = await screen.findByRole('dialog', { name: 'Изменить проект' });
  expect(within(dialog).getByLabelText('Название')).toHaveFocus();
});
it('does not open an automatic-group dialog when the catalog project disappeared', async () => {
  mockFetch({ 'GET /api/catalog/projects': () => ({ status: 200, body: [] }), 'GET /api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: [] } }) });
  const user = userEvent.setup();
  render(<ProjectActions project={project} total={3} />);
  await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
  await user.click(screen.getByRole('menuitem', { name: 'Изменить проект' }));
  await vi.waitFor(() => expect(useStore.getState().toasts.at(-1)?.title).toBe('Проект не найден'));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('retains the edit and marks the field for duplicate names; closes after success even if refresh fails', async () => {
  let reject = true;
  mockFetch({
    'GET /api/catalog/projects': () => ({ status: 200, body: [item] }),
    'PATCH /api/catalog/projects/p-e': () => (reject ? { status: 409, body: { error: 'name_conflict' } } : { status: 200 }),
    'GET /api/sidebar': () => ({ status: 500 }),
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const user = userEvent.setup();
  render(<ProjectActions project={project} total={3} />);
  await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
  await user.click(screen.getByRole('menuitem', { name: 'Изменить проект' }));
  const dialog = await screen.findByRole('dialog', { name: 'Изменить проект' });
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  expect(within(dialog).getByLabelText('Название')).toHaveAttribute('aria-invalid', 'true');
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Название проекта уже используется');
  reject = false;
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(warning).toHaveBeenCalled();
});
it('hides immediately with undo and restores durable hidden groups from the list', async () => {
  const calls = mockFetch({
    'PUT /api/projects/p-e/hidden': () => ({ status: 200 }),
    'DELETE /api/projects/p-e/hidden': () => ({ status: 200 }),
    'GET /api/projects/hidden': () => ({ status: 200, body: [{ ...project, path: '/vault' }] }),
    'GET /api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: [] } }),
  });
  const user = userEvent.setup();
  const view = render(
    <>
      <ProjectActions project={{ ...project, path: '/vault' }} total={3} />
      <Toasts />
    </>,
  );
  await user.click(screen.getByRole('button', { name: 'Действия проекта Stable' }));
  await user.click(screen.getByRole('menuitem', { name: 'Скрыть группу' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Отменить' }));
  expect(calls.some(call => call.method === 'DELETE')).toBe(true);
  view.unmount();
  render(<HiddenProjects onClose={() => undefined} />);
  await user.click(await screen.findByRole('button', { name: 'Вернуть Stable' }));
  expect(await screen.findByText('Скрытых групп нет')).toBeInTheDocument();
});
