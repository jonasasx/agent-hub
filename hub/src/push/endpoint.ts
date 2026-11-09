// Web Push endpoint of a subscription comes from the body of a request and the hub calls it: only a public https address (D6, SSRF).
import { isIP } from 'node:net';

const LOCAL_SUFFIXES = ['.local', '.lan', '.internal', '.localdomain'];

export function isSafePushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[') || isIP(host) !== 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (LOCAL_SUFFIXES.some(s => host.endsWith(s))) return false;
  return host.includes('.');
}
