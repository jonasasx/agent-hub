// Codex subscriptions on «Настройки → Подписки» (change provider-parity).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner } from '../../test/factories';
import { providerLoginArrived } from '../machines/ProviderLogin';
import { SubscriptionsPage } from './SubscriptionsPage';
import { SUB_A, SUB_B, SUB_C, subView, subsResponse } from './fixtures';
import { activeSubs, fullOrder } from './model';

const subs = () =>
  subsResponse({
    subscriptions: [
      subView({ id: SUB_A, name: 'Max', position: 0 }),
      subView({ id: SUB_C, name: 'ChatGPT Pro', position: 1, provider: 'codex', tokenHint: 'f9e8' }),
      subView({ id: SUB_B, name: 'Pro', position: 2 }),
    ],
    byProvider: { claude: { lastChoiceId: null, defaultId: SUB_A }, codex: { lastChoiceId: null, defaultId: SUB_C } },
  });

describe('model', () => {
  it('a block keeps its slots in the shared order', () => {
    const s = subs();
    expect(activeSubs(s, 'claude').map(x => x.id)).toEqual([SUB_A, SUB_B]);
    expect(activeSubs(s, 'codex').map(x => x.id)).toEqual([SUB_C]);
    expect(fullOrder(s, 'claude', [SUB_B, SUB_A])).toEqual([SUB_B, SUB_C, SUB_A]);
  });
});

describe('SubscriptionsPage with Codex', () => {
  beforeEach(() => {
    useStore.setState({ subs: subs(), runners: [] });
  });

  it('shows both providers, the Codex hint and its own add form', () => {
    render(<SubscriptionsPage />);
    expect(screen.getByRole('group', { name: 'Claude' })).toBeInTheDocument();
    const codex = screen.getByRole('group', { name: 'Codex' });
    expect(codex).toHaveTextContent('ChatGPT Pro');
    expect(codex).toHaveTextContent('…f9e8');
    expect(codex).toHaveTextContent('по умолчанию');
    expect(codex).toHaveTextContent('Войти в ChatGPT (новая подписка Codex)');
  });

  it('the name is checked before a sign-in starts; without a machine the reason is shown', async () => {
    render(<SubscriptionsPage />);
    const codex = screen.getByRole('group', { name: 'Codex' });
    expect(codex).toHaveTextContent('Нет машины в сети с установленным Codex');
    await userEvent.type(screen.getByLabelText('Название'), 'x');
  });

  it('the end of a sign-in with a subscription id is not an error without a flow', () => {
    expect(() => providerLoginArrived({ runnerId: 'r', provider: 'codex', loginId: 'l', ok: true })).not.toThrow();
  });
});

describe('ChatGPT sign-in from «Подписки»', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('name → device code → the end event → the list is reloaded with the new subscription', async () => {
    const added = subView({ id: SUB_C, name: 'ChatGPT Pro', position: 2, provider: 'codex', tokenHint: 'f9e8' });
    let signedIn = false;
    const calls = mockFetch({
      'GET /api/subscriptions': () => ({ status: 200, body: subsResponse({ subscriptions: signedIn ? [subView(), added] : [subView()] }) }),
      'POST /api/subscriptions/codex-login': () => ({ status: 200, body: { loginId: 'L1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } }),
    });
    useStore.setState({ subs: subsResponse(), runners: [runner({ id: 'hp', name: 'HP', online: true, providers: [{ id: 'codex', version: '0.166.0', login: 'missing' }] })] });
    render(<SubscriptionsPage />);
    await userEvent.type(screen.getByLabelText('Название'), 'ChatGPT Pro');
    await userEvent.click(screen.getByRole('button', { name: 'Войти в ChatGPT' }));
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
    expect(calls.find(c => c.url.includes('codex-login'))?.body).toEqual({ runnerId: 'hp', name: 'ChatGPT Pro' });
    signedIn = true;
    act(() => providerLoginArrived({ runnerId: 'hp', provider: 'codex', loginId: 'L1', ok: true, subscriptionId: SUB_C }));
    expect(await screen.findByText('Вход выполнен')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Codex' })).toHaveTextContent('…f9e8');
  });
});
