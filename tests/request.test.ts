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

  it('trusts x-vercel-forwarded-for on Vercel', () => {
    vi.stubEnv('VERCEL', '1');
    const ip = extractClientIp(
      makeReq({ 'x-vercel-forwarded-for': '9.9.9.9, 10.0.0.1' })
    );
    expect(ip).toBe('9.9.9.9');
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
