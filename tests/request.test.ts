import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAll } from './setup';

const { extractClientIp } = await import('../src/utils/request');

function makeReq(headers: Record<string, string | string[]>, ip = '1.2.3.4') {
  return { headers, ip, socket: { remoteAddress: ip } } as never;
}

beforeEach(() => {
  resetAll();
});

describe('extractClientIp', () => {
  it('ignores a spoofed x-vercel-forwarded-for when not on Vercel', () => {
    const ip = extractClientIp(makeReq({ 'x-vercel-forwarded-for': '9.9.9.9' }));
    expect(ip).toBe('1.2.3.4');
  });

  it('prefers the peer address over the header on Vercel (throttle key cannot be forged)', () => {
    vi.stubEnv('VERCEL', '1');
    const ip = extractClientIp(
      makeReq({ 'x-vercel-forwarded-for': '9.9.9.9, 10.0.0.1' }, '5.6.7.8')
    );
    // Even if the platform ever appended a client-supplied value instead of
    // overwriting, the attacker-picked first value must not key the throttle.
    expect(ip).toBe('5.6.7.8');
  });

  it('falls back to x-vercel-forwarded-for only when the peer is unknown', () => {
    vi.stubEnv('VERCEL', '1');
    expect(extractClientIp(makeReq({ 'x-vercel-forwarded-for': '9.9.9.9, 10.0.0.1' }, ''))).toBe(
      '9.9.9.9'
    );
  });

  it('normalizes IPv4-mapped IPv6 peer addresses to plain IPv4', () => {
    expect(extractClientIp(makeReq({}, '::ffff:203.0.113.7'))).toBe('203.0.113.7');
  });

  it('honors x-forwarded-for only with TRUST_FORWARDED_HEADERS', () => {
    const spoofed = { 'x-forwarded-for': '8.8.8.8' };
    expect(extractClientIp(makeReq(spoofed))).toBe('1.2.3.4');

    vi.stubEnv('TRUST_FORWARDED_HEADERS', 'true');
    expect(extractClientIp(makeReq(spoofed))).toBe('8.8.8.8');
  });

  it('returns null when no address is available', () => {
    expect(extractClientIp(makeReq({}, ''))).toBeNull();
  });
});
