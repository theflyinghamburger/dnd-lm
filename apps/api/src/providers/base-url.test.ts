/**
 * M7.3 — base URL validation: the SSRF wall.
 * All DNS is faked; no network in unit tests.
 */
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORBIDDEN_RANGES,
  checkBaseUrl,
  forbiddenRangeOf,
  guardedFetch,
  resolvedIpFetch,
} from './base-url';

const resolvingTo = (addresses: string[]) => vi.fn(async () => addresses);

describe('checkBaseUrl — literals, no DNS', () => {
  it('accepts a public https URL that resolves to a public address', async () => {
    const verdict = await checkBaseUrl('https://api.anthropic.com/', {
      resolve: resolvingTo(['93.184.216.34']),
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts a public literal IP without any DNS lookup', async () => {
    // CI resolvers refuse IP-literal lookups; a literal must settle here, never in DNS.
    const resolve = resolvingTo([]);
    const verdict = await checkBaseUrl('https://93.184.216.34/v1', { resolve });
    expect(verdict).toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects the cloud metadata endpoint by name', async () => {
    const verdict = await checkBaseUrl('https://169.254.169.254/latest/meta-data/');
    expect(verdict).toEqual({
      ok: false,
      reason: 'base_url host is in the forbidden range 169.254.0.0/16',
    });
  });

  it.each(FORBIDDEN_RANGES.filter((r) => !r.includes(':')))(
    'rejects every forbidden v4 range literal (%s)',
    async (range) => {
      const [base, prefixStr] = range.split('/');
      const prefix = Number(prefixStr);
      const [a, b, c, d] = base!.split('.').map(Number);
      // one address inside the range: flip the top host bit
      const insideInt = ((a! << 24) | (b! << 16) | (c! << 8) | d! | (1 << (31 - prefix))) >>> 0;
      const inside = [
        insideInt >>> 24,
        (insideInt >>> 16) & 255,
        (insideInt >>> 8) & 255,
        insideInt & 255,
      ].join('.');
      const verdict = await checkBaseUrl(`https://${inside}:8443/`);
      expect(verdict).toEqual({
        ok: false,
        reason: `base_url host is in the forbidden range ${range}`,
      });
    },
  );

  it('rejects forbidden v6 literals', async () => {
    expect(await checkBaseUrl('https://[::1]:443/')).toEqual({
      ok: false,
      reason: 'base_url host is in the forbidden range ::1/128',
    });
    expect(await checkBaseUrl('https://[fc00::5]/')).toEqual({
      ok: false,
      reason: 'base_url host is in the forbidden range fc00::/7',
    });
    expect(await checkBaseUrl('https://[fe80::1]/')).toEqual({
      ok: false,
      reason: 'base_url host is in the forbidden range fe80::/10',
    });
  });

  it('rejects a plain-URL and a non-http(s) scheme', async () => {
    expect(await checkBaseUrl('not a url')).toEqual({
      ok: false,
      reason: 'base_url is not a valid URL',
    });
    expect(await checkBaseUrl('ftp://example.com/')).toEqual({
      ok: false,
      reason: 'base_url must use https',
    });
  });

  it('rejects v4-mapped v6 loopback', async () => {
    expect(forbiddenRangeOf('::ffff:127.0.0.1')).toBe('127.0.0.0/8');
    const verdict = await checkBaseUrl('https://dm.example/', {
      resolve: resolvingTo(['::ffff:127.0.0.1']),
    });
    expect(verdict).toEqual({
      ok: false,
      reason: 'host resolved into the forbidden range 127.0.0.0/8',
    });
  });

  it('rejects an unrecognized resolved address rather than refusing to classify it', async () => {
    expect(forbiddenRangeOf('not-an-ip')).toBe('unrecognized');
    const verdict = await checkBaseUrl('https://dm.example/', { resolve: resolvingTo(['weird']) });
    expect(verdict).toEqual({ ok: false, reason: 'host resolved to an unrecognized address' });
  });
});

describe('checkBaseUrl — DNS behaviour', () => {
  it('rejects a hostname that resolves into a private range', async () => {
    const resolve = resolvingTo(['10.1.2.3']);
    const verdict = await checkBaseUrl('https://dm.example/', { resolve });
    expect(verdict).toEqual({
      ok: false,
      reason: 'host resolved into the forbidden range 10.0.0.0/8',
    });
  });

  it('rejects when any of several resolved addresses is private', async () => {
    const verdict = await checkBaseUrl('https://dm.example/', {
      resolve: resolvingTo(['93.184.216.34', '169.254.169.254']),
    });
    expect((verdict as { reason: string }).reason).toContain('169.254.0.0/16');
  });

  it('rejects a host that resolves to nothing', async () => {
    const verdict = await checkBaseUrl('https://nope.example.', { resolve: resolvingTo([]) });
    expect(verdict).toEqual({ ok: false, reason: 'host did not resolve to any address' });
  });

  it('DNS rebinding: public at save time, internal at request time → refused', async () => {
    const save = await checkBaseUrl('https://dm.example/', {
      resolve: resolvingTo(['93.184.216.34']),
    });
    expect(save).toEqual({ ok: true });
    // the same function is the request-time re-check — it resolves again, and
    // nothing is cached between the two calls
    const atRequest = await checkBaseUrl('https://dm.example/', {
      resolve: resolvingTo(['169.254.169.254']),
    });
    expect(atRequest).toEqual({
      ok: false,
      reason: 'host resolved into the forbidden range 169.254.0.0/16',
    });
  });
});

describe('checkBaseUrl — local inference and allowlist', () => {
  it('rejects http://localhost:11434 without ALLOW_LOCAL_PROVIDERS, but accepts it with the flag', async () => {
    const resolve = resolvingTo(['127.0.0.1']);
    expect(await checkBaseUrl('http://localhost:11434/v1', { resolve })).toEqual({
      ok: false,
      reason: 'plain http is only allowed for localhost/127.0.0.1 with ALLOW_LOCAL_PROVIDERS set',
    });
    const flagged = await checkBaseUrl('http://localhost:11434/v1', { allowLocal: true, resolve });
    expect(flagged).toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows http for 127.0.0.1 and ::1 with the flag', async () => {
    expect(await checkBaseUrl('http://127.0.0.1:11434/', { allowLocal: true })).toEqual({
      ok: true,
    });
    expect(await checkBaseUrl('http://[::1]:11434/', { allowLocal: true })).toEqual({ ok: true });
  });

  it('rejects http to a non-loopback host even with the flag', async () => {
    const verdict = await checkBaseUrl('http://internal.example/v1', {
      allowLocal: true,
      resolve: resolvingTo(['93.184.216.34']),
    });
    expect((verdict as { reason: string }).reason).toContain('plain http');
  });

  it('https://localhost still resolves and is refused as loopback', async () => {
    const verdict = await checkBaseUrl('https://localhost/', {
      resolve: resolvingTo(['127.0.0.1']),
    });
    expect((verdict as { reason: string }).reason).toContain('127.0.0.0/8');
  });

  it('with PROVIDER_HOST_ALLOWLIST set: listed host passes without DNS, others fail even when public', async () => {
    const resolve = vi.fn(async () => ['93.184.216.34']);
    const opts = { allowlist: ['ollama.lab'], resolve };
    expect(await checkBaseUrl('https://ollama.lab/v1', opts)).toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
    expect(await checkBaseUrl('https://api.anthropic.com/', opts)).toEqual({
      ok: false,
      reason: 'host is not in PROVIDER_HOST_ALLOWLIST',
    });
  });

  it('allowlist matching is case-insensitive and trims entries', async () => {
    const verdict = await checkBaseUrl('https://Ollama.LAB/v1', { allowlist: [' ollama.lab '] });
    expect(verdict).toEqual({ ok: true });
  });
});

describe('guardedFetch — the redirect policy', () => {
  const redirected = (status: number, location: string, url: string) => {
    const res = new Response(null, { status, headers: { location } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };

  it('refuses a cross-host redirect before any second request goes out', async () => {
    const base = vi.fn(async (_input: string, _init?: RequestInit) =>
      redirected(302, 'http://evil.example/phish', 'https://provider.example/v1/messages'),
    );
    const res = await guardedFetch(base as unknown as typeof fetch)(
      'https://provider.example/v1/messages',
    );
    expect(res.status).toBe(403);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0]?.[1]).toEqual({ redirect: 'manual' });
  });

  it('follows a same-host redirect, relative location included', async () => {
    const base = vi.fn(async (_input: unknown, init?: RequestInit) =>
      init?.redirect === 'manual'
        ? redirected(301, '/v1/messages', 'https://provider.example/v1')
        : new Response('ok', { status: 200 }),
    );
    const res = await guardedFetch(base as unknown as typeof fetch)('https://provider.example/v1');
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1]?.[1]).toEqual({ redirect: 'follow' });
  });

  it('passes non-redirect responses through untouched', async () => {
    const base = vi.fn(
      async (_input: string, _init?: RequestInit) => new Response('hi', { status: 200 }),
    );
    const res = await guardedFetch(base as unknown as typeof fetch)('https://provider.example/x');
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0]?.[1]).toEqual({ redirect: 'manual' });
  });
});

describe('resolvedIpFetch — the openai_compatible request path (M7.7)', () => {
  let server: Server;
  let port: number;
  const seen: Array<{ host?: string; auth?: string; body?: unknown; method?: string }> = [];

  const listen = (handler: Parameters<typeof createServer>[1] | undefined): Promise<void> =>
    new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });

  const echoJson =
    (record: (req: import('node:http').IncomingMessage, body: unknown) => void) =>
    (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        const body = data ? (JSON.parse(data) as unknown) : {};
        record(req, body);
        res.writeHead(200, { 'content-type': 'application/json', 'x-served': 'yes' });
        res.end(JSON.stringify({ ok: true }));
      });
    };

  beforeEach(() => {
    seen.length = 0;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(() => resolve(null)));
  });

  it('serves a local endpoint when ALLOW_LOCAL_PROVIDERS is on, preserving method, body and Host', async () => {
    vi.stubEnv('ALLOW_LOCAL_PROVIDERS', 'true');
    await listen(
      echoJson((req, body) => seen.push({ host: req.headers.host, method: req.method, body })),
    );
    const res = await resolvedIpFetch()(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer key-a' },
      body: JSON.stringify({ model: 'local', stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-served')).toBe('yes');
    await res.text();
    expect(seen[0]).toMatchObject({
      host: `127.0.0.1:${port}`,
      method: 'POST',
      body: { model: 'local', stream: true },
    });
  });

  it('refuses the same local URL without the opt-in flag', async () => {
    await listen(echoJson((req) => seen.push({ method: req.method })));
    await expect(
      resolvedIpFetch()(`http://127.0.0.1:${port}/v1`, { method: 'GET' }),
    ).rejects.toThrow(/provider fetch refused/);
    expect(seen).toHaveLength(0);
  });

  it('refuses a private-range host that the check classifies as forbidden', async () => {
    vi.stubEnv('ALLOW_LOCAL_PROVIDERS', 'true');
    await listen(echoJson((req) => seen.push({ method: req.method })));
    // 10.255.255.1 is in 10.0.0.0/8: the flag opens loopback only, never a
    // private range, so the request dies before any socket goes out. https is
    // used so this is the range check, not the plain-http check, that refuses.
    await expect(
      resolvedIpFetch()(`https://10.255.255.1:9999/v1`, { method: 'GET' }),
    ).rejects.toThrow(/forbidden range 10\.0\.0\.0\/8/);
  });

  it('refuses a cross-host redirect and returns same-host 3xx as-is (no auto-follow)', async () => {
    vi.stubEnv('ALLOW_LOCAL_PROVIDERS', 'true');
    await listen((req, res) => {
      const location = req.url === '/same' ? `/final` : `http://8.8.8.8:1/phish`;
      res.writeHead(302, { location });
      res.end();
    });
    const cross = await resolvedIpFetch()(`http://127.0.0.1:${port}/redirect`, {
      method: 'GET',
    });
    expect(cross.status).toBe(403);
    // Same-host: not followed (undici never follows), handed back as-is so the
    // SDK treats the 3xx as the error it is.
    const same = await resolvedIpFetch()(`http://127.0.0.1:${port}/same`, {
      method: 'GET',
    });
    expect(same.status).toBe(302);
    expect(same.headers.get('location')).toBe('/final');
  });
});
