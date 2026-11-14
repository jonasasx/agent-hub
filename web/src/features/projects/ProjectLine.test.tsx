import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectLine } from './ProjectButton';
import { api, ApiError } from '../../api/client';
import { session } from '../../test/factories';

describe('project line, hub asks', () => {
  beforeEach(() => vi.spyOn(api, 'answerProjectSuggestion').mockResolvedValue({ ok: true }));
  afterEach(() => vi.restoreAllMocks());
  const inputHash = 'a'.repeat(64);
  const suggestion = {
    inputHash,
    options: [
      { projectId: 'vpn', name: 'VPN Александра', colorKey: 'infra' as const },
      { projectId: 'net', name: 'Домашняя сеть', colorKey: 'tools' as const },
    ],
    newProjectName: 'Роутер MikroTik',
  };
  it('keeps the project unassigned until a click, accepts the chosen option and hides the question', async () => {
    const s = session({ projectSuggestion: suggestion });
    render(<ProjectLine s={s} />);
    expect(screen.getByRole('button', { name: 'VPN Александра' })).toBeInTheDocument();
    expect(api.answerProjectSuggestion).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Домашняя сеть' }));
    expect(api.answerProjectSuggestion).toHaveBeenCalledWith(s.id, { action: 'accept', projectId: 'net', inputHash });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
  it('creates the proposed project, or one with an edited name', async () => {
    const s = session({ projectSuggestion: suggestion });
    const view = render(<ProjectLine s={s} />);
    await userEvent.click(screen.getByRole('button', { name: 'Создать проект «Роутер MikroTik»' }));
    expect(api.answerProjectSuggestion).toHaveBeenCalledWith(s.id, { action: 'create', name: 'Роутер MikroTik', inputHash });
    view.unmount();
    render(<ProjectLine s={session({ projectSuggestion: { ...suggestion, inputHash: 'b'.repeat(64) } })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Другое имя…' }));
    const input = screen.getByRole('textbox', { name: 'Имя нового проекта' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Сеть дома');
    await userEvent.click(screen.getByRole('button', { name: 'Создать' }));
    expect(api.answerProjectSuggestion).toHaveBeenLastCalledWith(expect.any(String), { action: 'create', name: 'Сеть дома', inputHash: 'b'.repeat(64) });
  });
  it('«Без проекта» dismisses; an empty suggestion still offers a new project; no question for an assigned session', async () => {
    const s = session({ projectSuggestion: suggestion });
    const view = render(<ProjectLine s={s} />);
    await userEvent.click(screen.getByRole('button', { name: 'Без проекта' }));
    expect(api.answerProjectSuggestion).toHaveBeenCalledWith(s.id, { action: 'dismiss', inputHash });
    view.rerender(<ProjectLine s={session({ projectSuggestion: { inputHash: 'c'.repeat(64), options: [], newProjectName: null } })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Подходящего проекта нет.');
    expect(screen.getByRole('button', { name: 'Новый проект…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Без проекта' })).toBeInTheDocument();
    view.rerender(<ProjectLine s={session({ projectSuggestion: { ...suggestion, inputHash: 'd'.repeat(64) }, catalogProject: { id: 'vpn', name: 'VPN' } })} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('shows an accessible error for a taken name and keeps the choice available', async () => {
    vi.mocked(api.answerProjectSuggestion).mockRejectedValueOnce(new ApiError(409, 'name_conflict'));
    render(<ProjectLine s={session({ projectSuggestion: suggestion })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Создать проект «Роутер MikroTik»' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Проект с таким именем уже есть');
    expect(screen.getByRole('button', { name: 'VPN Александра' })).toBeEnabled();
  });
  it('«Позже» hides the question in the tab without a request to the hub', async () => {
    render(<ProjectLine s={session({ projectSuggestion: suggestion })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Позже' }));
    expect(api.answerProjectSuggestion).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('shows «? Проект» instead of a project chip while the hub asks', () => {
    render(<ProjectLine s={session({ projectSuggestion: suggestion })} />);
    expect(screen.getByRole('button', { name: 'Проект не выбран' })).toHaveTextContent('? Проект');
  });
});
