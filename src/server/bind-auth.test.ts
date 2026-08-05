import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { assertBindAuthValid, firstPublicAddress } from './support.js';
import type { TokenMap } from './auth.js';

const NO_TOKENS: TokenMap = {};
const SOME_TOKENS: TokenMap = { abc: { name: 'Alice', scopes: ['support'] } };

// networkInterfaces() returns a lot of fields we never read. Only `address` and
// `internal` drive the decision, so build the rest as filler.
function nic(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    internal,
    netmask: '255.255.255.0',
    family: address.includes(':') ? 'IPv6' : 'IPv4',
    mac: '00:00:00:00:00:00',
    cidr: null,
  } as NetworkInterfaceInfo;
}

const PRIVATE_HOST = { Wi__Fi: [nic('192.168.1.40')], Loopback: [nic('127.0.0.1', true)] };
const PUBLIC_HOST = { Wi__Fi: [nic('192.168.1.40')], Ethernet: [nic('93.184.216.34')] };

describe('firstPublicAddress', () => {
  it('returns null when every non-internal address is private', () => {
    expect(firstPublicAddress(PRIVATE_HOST)).toBeNull();
  });

  it('names the offending address so the operator knows which NIC blocked boot', () => {
    expect(firstPublicAddress(PUBLIC_HOST)).toBe('93.184.216.34');
  });

  it('ignores internal (loopback) interfaces', () => {
    expect(firstPublicAddress({ Loopback: [nic('127.0.0.1', true)], Wi__Fi: [nic('10.0.0.5')] })).toBeNull();
  });

  it('accepts IPv6 link-local and unique-local as private', () => {
    expect(firstPublicAddress({ Wi__Fi: [nic('fe80::1'), nic('fd12:3456::1')] })).toBeNull();
  });

  it('rejects a routable IPv6 address', () => {
    expect(firstPublicAddress({ Wi__Fi: [nic('2001:db8::1')] })).toBe('2001:db8::1');
  });

  it('accepts RFC 6598 shared address space (Tailscale)', () => {
    // Caught by running this on a real machine: Tailscale assigns 100.64.0.0/10,
    // which is not RFC1918 but is not globally routable either. Treating it as
    // public refused boot on a perfectly ordinary dev laptop.
    expect(firstPublicAddress({ Tailscale: [nic('100.83.177.7')] })).toBeNull();
    expect(firstPublicAddress({ Tailscale: [nic('100.64.0.1'), nic('100.127.255.254')] })).toBeNull();
  });

  it('still rejects 100.x outside the /10', () => {
    // 100.63.x and 100.128.x are ordinary routable space — the boundary matters.
    expect(firstPublicAddress({ Eth: [nic('100.63.255.255')] })).toBe('100.63.255.255');
    expect(firstPublicAddress({ Eth: [nic('100.128.0.1')] })).toBe('100.128.0.1');
  });

  it('fails closed when no non-internal interface is found', () => {
    // "We found no evidence of a public address" is not "there is none" — an
    // empty map must not silently authorise anonymous mode.
    expect(firstPublicAddress({})).not.toBeNull();
    expect(firstPublicAddress({ Loopback: [nic('127.0.0.1', true)] })).not.toBeNull();
  });
});

describe('assertBindAuthValid', () => {
  it('permits loopback with no tokens and no anonymous flag', () => {
    expect(() => assertBindAuthValid('127.0.0.1', NO_TOKENS, false)).not.toThrow();
    expect(() => assertBindAuthValid('localhost', NO_TOKENS, false)).not.toThrow();
    expect(() => assertBindAuthValid('::1', NO_TOKENS, false)).not.toThrow();
  });

  describe('token mode (allowAnonymous=false)', () => {
    it('refuses a non-loopback bind with an empty token map', () => {
      expect(() => assertBindAuthValid('0.0.0.0', NO_TOKENS, false)).toThrow(/without tokens/);
      expect(() => assertBindAuthValid('192.168.1.40', NO_TOKENS, false)).toThrow(/without tokens/);
    });

    it('permits a non-loopback bind once tokens exist', () => {
      expect(() => assertBindAuthValid('0.0.0.0', SOME_TOKENS, false)).not.toThrow();
    });

    it('does not consult the interface list — tokens are the gate', () => {
      expect(() => assertBindAuthValid('0.0.0.0', SOME_TOKENS, false, PUBLIC_HOST)).not.toThrow();
    });
  });

  describe('anonymous mode on an explicit address', () => {
    it('permits an RFC1918 bind', () => {
      expect(() => assertBindAuthValid('192.168.1.40', NO_TOKENS, true)).not.toThrow();
      expect(() => assertBindAuthValid('10.1.2.3', NO_TOKENS, true)).not.toThrow();
      expect(() => assertBindAuthValid('172.16.0.1', NO_TOKENS, true)).not.toThrow();
    });

    it('refuses a publicly-routable bind', () => {
      expect(() => assertBindAuthValid('93.184.216.34', NO_TOKENS, true)).toThrow(/refuses BB_SUPPORT_ALLOW_ANONYMOUS/);
    });

    it('refuses 172.32.x — just outside the RFC1918 block', () => {
      expect(() => assertBindAuthValid('172.32.0.1', NO_TOKENS, true)).toThrow(/refuses BB_SUPPORT_ALLOW_ANONYMOUS/);
    });
  });

  describe('anonymous mode on a wildcard bind', () => {
    // This is the case the LAN-service setup actually uses, and the reason the
    // interface check exists: '0.0.0.0' is neither loopback nor RFC1918 as a
    // string, so it can only be judged by what the host is attached to.
    it('permits 0.0.0.0 when every interface is private', () => {
      expect(() => assertBindAuthValid('0.0.0.0', NO_TOKENS, true, PRIVATE_HOST)).not.toThrow();
    });

    it('permits :: and an empty bind on the same terms', () => {
      expect(() => assertBindAuthValid('::', NO_TOKENS, true, PRIVATE_HOST)).not.toThrow();
      expect(() => assertBindAuthValid('', NO_TOKENS, true, PRIVATE_HOST)).not.toThrow();
    });

    it('refuses 0.0.0.0 when the host has a public address, and names it', () => {
      expect(() => assertBindAuthValid('0.0.0.0', NO_TOKENS, true, PUBLIC_HOST))
        .toThrow(/93\.184\.216\.34/);
    });

    it('refuses a wildcard bind when no interface can be inspected', () => {
      expect(() => assertBindAuthValid('0.0.0.0', NO_TOKENS, true, {})).toThrow(/wildcard bind/);
    });

    it('explains the empty-interface case as "cannot rule out", not as a found address', () => {
      // Fail-closed is right, but the operator must not be sent hunting for a
      // public IP that was never detected.
      expect(() => assertBindAuthValid('0.0.0.0', NO_TOKENS, true, {}))
        .toThrow(/cannot rule out/);
      expect(() => assertBindAuthValid('0.0.0.0', NO_TOKENS, true, {}))
        .not.toThrow(/has a non-private address/);
    });

    it('still refuses when tokens exist but the host is public — anonymous is the risk, not the tokens', () => {
      expect(() => assertBindAuthValid('0.0.0.0', SOME_TOKENS, true, PUBLIC_HOST)).toThrow(/wildcard bind/);
    });
  });
});
