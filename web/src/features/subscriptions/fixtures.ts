// Test data of the subscriptions UI (change claude-subscriptions).
import type { SubscriptionView, SubscriptionsResponse } from '../../api/types';

export const SUB_A = '00000000-0000-4000-a000-00000000000a';
export const SUB_B = '00000000-0000-4000-a000-00000000000b';
export const SUB_C = '00000000-0000-4000-a000-00000000000c';

export const subView = (over: Partial<SubscriptionView> = {}): SubscriptionView => ({
  id: SUB_A,
  name: 'Max личная',
  position: 0,
  autoSwitch: false,
  retired: false,
  tokenHint: 'a1b2',
  tokenUpdatedAt: '2026-10-27T05:00:00Z',
  limitResetsAt: null,
  limitKind: null,
  tokenRejected: false,
  provider: 'claude',
  ...over,
});

export const subsResponse = (over: Partial<SubscriptionsResponse> = {}): SubscriptionsResponse => {
  const r: SubscriptionsResponse = {
    enabled: true,
    subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1, tokenHint: 'c3d4' })],
    lastChoiceId: null,
    defaultId: SUB_A,
    connectorsHint: false,
    byProvider: { claude: { lastChoiceId: null, defaultId: SUB_A }, codex: { lastChoiceId: null, defaultId: null } },
    ...over,
  };
  // the Claude entry follows the top-level fields unless a test sets byProvider itself
  if (!over.byProvider) r.byProvider = { ...r.byProvider, claude: { lastChoiceId: r.lastChoiceId, defaultId: r.defaultId } };
  return r;
};
