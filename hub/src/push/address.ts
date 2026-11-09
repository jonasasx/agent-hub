// The address a push endpoint resolves to must be public (D6, SSRF): a public-looking name can point into the internal network.
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/** The IPv4 inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:aabb:ccdd), or null. */
function mappedV4(ip: string): string | null {
  const m = /^(?:0{0,4}:){2,5}ffff:(.+)$/i.exec(ip) ?? /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1]!;
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for a global unicast address; loopback, private, link-local, CGNAT, ULA, multicast, unspecified and documentation ranges are not. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const v4 = mappedV4(ip);
    if (v4) return isPublicAddress(v4);
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}
