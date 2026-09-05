/**
 * Base URL validation — the SSRF wall (M7.3). A user-supplied URL the server
 * will fetch is a trust boundary, not a config field, so it is checked at
 * save *and* re-checked at request time: the same function both times, no
 * caching, because a host that passed can be repointed afterwards (DNS
 * rebinding) and the metadata endpoint at 169.254.169.254 is the whole point
 * of an SSRF attempt.
 */
import { resolve4, resolve6 } from 'node:dns/promises';

/** Ranges the server must never be talked into fetching (MVP.md M7.3). */
export const FORBIDDEN_RANGES: string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16', // link-local — 169.254.169.254 is the cloud metadata endpoint
  '::/128',
  '::1/128',
  // fe80::/10 is a subset of fc00::/7 — listed first so the reason names
  // link-local, not the whole unique-local block
  'fe80::/10',
  'fc00::/7',
];

/** http (not just https) is permitted for exactly these, and only opted in. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export type UrlCheckOptions = {
  /** Opt in to http://localhost / http://127.0.0.1 for local inference. */
  allowLocal?: boolean;
  /** When non-empty, only these hostnames pass — checked exactly, no DNS. */
  allowlist?: string[];
  /** Injectable for tests; defaults to node:dns A + AAAA. */
  resolve?: (host: string) => Promise<string[]>;
};

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The save-time check — and, because it re-resolves on every call, the
 * request-time re-check as well. M7.4 calls it on create/update; M7.7 calls
 * it before each provider construction.
 */
export async function checkBaseUrl(
  rawUrl: string,
  opts: UrlCheckOptions = {},
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'base_url is not a valid URL' };
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (url.protocol === 'http:') {
    if (!(LOCAL_HOSTS.has(host) && opts.allowLocal)) {
      return {
        ok: false,
        reason: 'plain http is only allowed for localhost/127.0.0.1 with ALLOW_LOCAL_PROVIDERS set',
      };
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: 'base_url must use https' };
  }

  const allowlist = (opts.allowlist ?? []).map((h) => h.trim().toLowerCase());
  if (allowlist.length > 0) {
    return allowlist.includes(host.toLowerCase())
      ? { ok: true }
      : { ok: false, reason: 'host is not in PROVIDER_HOST_ALLOWLIST' };
  }

  // The opt-in: loopback is normally forbidden, ALLOW_LOCAL_PROVIDERS says
  // otherwise — for the three names that always mean loopback, only.
  if (opts.allowLocal && LOCAL_HOSTS.has(host)) {
    return { ok: true };
  }

  // A literal IP is fully classified here — no (and never) DNS after it, so
  // the verdict is deterministic even where resolvers refuse IP-literal
  // lookups (the suite's public IP must pass offline). Only unclassified
  // hostnames are resolved.
  const literal = forbiddenRangeOf(host);
  if (literal !== null && literal !== 'unrecognized')
    return { ok: false, reason: `base_url host is in the forbidden range ${literal}` };
  if (literal === null) return { ok: true };

  const resolve = opts.resolve ?? defaultResolve;
  return verdictFor(await resolve(host));
}

function verdictFor(addresses: string[]): UrlVerdict {
  if (addresses.length === 0) return { ok: false, reason: 'host did not resolve to any address' };
  for (const address of addresses) {
    const range = forbiddenRangeOf(address);
    if (range === 'unrecognized') {
      return { ok: false, reason: 'host resolved to an unrecognized address' };
    }
    if (range !== null) {
      return { ok: false, reason: `host resolved into the forbidden range ${range}` };
    }
  }
  return { ok: true };
}

/**
 * Forbidden range for one address, `null` when public, `'unrecognized'` when
 * it cannot be classified at all — and failing to classify is refused, never
 * waved through.
 */
export function forbiddenRangeOf(address: string): string | null | 'unrecognized' {
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (isIpv4Literal(mapped)) return forbiddenV4(mapped);
  }
  if (isIpv4Literal(ip)) return forbiddenV4(ip);
  const words = ipv6ToWords(ip);
  if (words) {
    for (const range of FORBIDDEN_RANGES) {
      if (range.includes(':') && inCidr6(words, range)) return range;
    }
    return null;
  }
  return 'unrecognized';
}

/* ------------------------------------------------------------------ */
/* Address arithmetic, no dependencies                                 */
/* ------------------------------------------------------------------ */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4Literal(ip: string): boolean {
  const m = IPV4.exec(ip);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

function ip4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function forbiddenV4(ip: string): string | null {
  const value = ip4ToInt(ip);
  for (const range of FORBIDDEN_RANGES) {
    if (!range.includes(':')) {
      const [base, prefixStr] = range.split('/');
      const prefix = Number(prefixStr);
      const mask = prefix === 0 ? 0 : (((1 << prefix) - 1) << (32 - prefix)) >>> 0;
      if ((value & mask) === (ip4ToInt(base!) & mask)) return range;
    }
  }
  return null;
}

/** Expand an IPv6 address to a 128-bit pair; null when malformed. */
function ipv6ToWords(ip: string): [bigint, bigint] | null {
  let s = ip.toLowerCase();
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4Tail) {
    const parts = v4Tail[1]!.split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    s =
      s.slice(0, s.length - v4Tail[1]!.length) +
      ((parts[0]! * 256 + parts[1]!) >>> 0).toString(16) +
      ':' +
      ((parts[2]! * 256 + parts[3]!) >>> 0).toString(16);
  }
  let groups: string[];
  if (s.includes('::')) {
    if (s.split('::').length > 2) return null;
    const [left, right] = s.split('::');
    const lg = left ? left.split(':') : [];
    const rg = right ? right.split(':') : [];
    if (lg.length + rg.length > 7) return null;
    groups = [...lg, ...Array<string>(8 - lg.length - rg.length).fill('0'), ...rg];
  } else {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  }
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 8; i++) {
    const word = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
    const value = BigInt('0x' + word);
    if (i < 4) hi = (hi << 16n) | value;
    else lo = (lo << 16n) | value;
  }
  return [hi, lo];
}

function inCidr6(words: [bigint, bigint], cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const range = ipv6ToWords(base!)!;
  const full = (w: [bigint, bigint]) => (w[0] << 64n) | w[1];
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (full(words) & mask) === (full(range) & mask);
}

/** node:dns for both families; a name with records in neither resolves to nothing. */
async function defaultResolve(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
  return [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
}

/** Deployment flags, read at call time so a rotated env needs no restart. */
export function providerUrlEnv(): Pick<UrlCheckOptions, 'allowLocal' | 'allowlist'> {
  const flag = process.env.ALLOW_LOCAL_PROVIDERS;
  return {
    allowLocal: flag === '1' || flag === 'true',
    allowlist: (process.env.PROVIDER_HOST_ALLOWLIST ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Redirect policy (MVP.md M7.3): a redirect to a different host is refused
 * before any second request goes out; same-host redirects are followed. The
 * SDKs' own fetch is wrapped, so this holds for both adapters in M7.7.
 */
export function guardedFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const first = await base(input, { ...init, redirect: 'manual' });
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      const from = new URL(first.url).host;
      const to = location ? new URL(location, first.url).host : null;
      if (to !== null && to !== from) {
        return new Response(null, { status: 403, statusText: 'cross-host redirect refused' });
      }
      return base(input, { ...init, redirect: 'follow' });
    }
    return first;
  };
}
