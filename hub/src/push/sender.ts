// A thin wrapper over `web-push` (D6): the VAPID details go to every call, no global state; tests replace the sender.
import { createECDH } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import * as webpush from 'web-push';
import { isPublicAddress } from './address.js';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendOptions {
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
}

/** `status` is the answer of the push service; null — nothing came from it (network, DNS, VAPID); `blocked` — the host resolves to a non-public address. */
export type PushSendResult = { ok: true } | { ok: false; status: number | null; blocked?: true };

export interface PushSender {
  send(target: PushTarget, payload: unknown, opts: PushSendOptions): Promise<PushSendResult>;
}

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

const TIMEOUT_MS = 10_000;

const systemResolver: Resolver = async host => {
  const list = await dnsLookup(host, { all: true, verbatim: true });
  return list.map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** The status of the push service out of an error of `web-push` (WebPushError.statusCode); anything else is a failure without a status. */
export function failureStatus(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

/** The VAPID triple works: the subject is mailto/https, the keys sign a header and make a pair. Never throws, never logs the keys. */
export function isValidVapid(vapid: VapidDetails): boolean {
  try {
    webpush.getVapidHeaders('https://push.example.com', vapid.subject, vapid.publicKey, vapid.privateKey, 'aes128gcm');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(vapid.privateKey, 'base64url'));
    return ecdh.getPublicKey().equals(Buffer.from(vapid.publicKey, 'base64url'));
  } catch {
    return false;
  }
}

/** An agent that connects to the address that was checked, not to the one a second lookup may give (DNS rebinding). */
function pinnedAgent(pinned: ResolvedAddress): Agent {
  return new Agent({
    lookup: (_host, options, callback) => {
      if (options && (options as { all?: boolean }).all) (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    },
  });
}

export function createWebPushSender(vapid: VapidDetails, resolve: Resolver = systemResolver): PushSender {
  return {
    async send(target, payload, opts) {
      let agent: Agent | undefined;
      try {
        const host = new URL(target.endpoint).hostname.replace(/^\[|\]$/g, '');
        const addresses = await resolve(host);
        if (addresses.length === 0 || addresses.some(a => !isPublicAddress(a.address))) return { ok: false, status: null, blocked: true };
        agent = pinnedAgent(addresses[0]!);
        await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), {
          TTL: opts.ttl,
          urgency: opts.urgency,
          ...(opts.topic ? { topic: opts.topic } : {}),
          timeout: TIMEOUT_MS,
          agent,
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        });
        return { ok: true };
      } catch (err) {
        // the error carries the endpoint and the body of the answer: only the status leaves this function
        return { ok: false, status: failureStatus(err) };
      } finally {
        agent?.destroy();
      }
    },
  };
}
