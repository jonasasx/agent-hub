// Web Push (change `web-push-notifications`): the API shapes of /api/push/* and the limits the hub and the web share.
import { z } from 'zod';

/** The body of a notification: machine name, separator and text together (design D3). */
export const PUSH_BODY_MAX = 120;
export const PUSH_TITLE_MAX = 80;
/** At most one push per session and reason within this window (design D4). */
export const PUSH_THROTTLE_MS = 30_000;
export const PUSH_MAX_DEVICES = 20;
/** Consecutive failed deliveries after which a subscription is dropped (design D6). */
export const PUSH_MAX_FAILURES = 10;

export const pushSubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
export type PushSubscribeBody = z.infer<typeof pushSubscribeSchema>;

export const pushTestSchema = z.object({ endpointHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type PushTestBody = z.infer<typeof pushTestSchema>;

export interface PushDeviceView {
  id: string;
  label: string;
  /** sha256 hex of the endpoint: how a device recognizes itself in the list. */
  endpointHash: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
}

export interface PushSubscriptionsResponse {
  configured: boolean;
  devices: PushDeviceView[];
}
