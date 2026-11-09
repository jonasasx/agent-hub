import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './address.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '142.250.74.110', '17.253.144.10', '2a00:1450:4001:81b::200e', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', ip => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1',
    'not an ip',
    '',
  ])('%s is not', ip => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('the edges of the ranges', () => {
    expect(isPublicAddress('172.15.255.255')).toBe(true);
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('100.63.255.255')).toBe(true);
    expect(isPublicAddress('100.128.0.1')).toBe(true);
  });
});
