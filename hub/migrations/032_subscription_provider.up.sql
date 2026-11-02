-- change `provider-parity` (design D2): a subscription belongs to a provider; the last choice is kept per provider.
ALTER TABLE subscriptions ADD COLUMN provider text NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'codex'));
ALTER TABLE users ADD COLUMN last_codex_subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL;
