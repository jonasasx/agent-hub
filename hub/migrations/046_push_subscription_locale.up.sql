-- change web-push-notifications: the language of the device when it subscribed, for a profile with no language ("as in the browser")
ALTER TABLE push_subscriptions ADD COLUMN locale text;
