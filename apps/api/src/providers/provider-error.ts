/**
 * What went wrong when a provider call failed (M7.5, reused by M7.9).
 *
 * Both SDKs throw their own error classes, and a local endpoint throws none of
 * them — it fails in undici, several `cause` levels down. This file is the one
 * place that turns any of those into the four classes the rest of the system
 * speaks: the *Test connection* action maps them onto its per-field result
 * (#23), and the operator log line reports the class rather than a pasted SDK
 * stack (#27).
 *
 * Duck-typed on `status` rather than `instanceof`: an `APIError` from the
 * OpenAI SDK and one from the Anthropic SDK are different classes with the same
 * shape, and importing both here to tell them apart would buy nothing.
 */

export type ProviderFailureClass =
  /** Nothing answered: DNS, refused, reset, timed out. */
  | 'unreachable'
  /** It answered and rejected the credential (401/403). */
  | 'unauthenticated'
  /** It answered, took the credential, and does not serve that model. */
  | 'model_not_found'
  /** It answered and failed for some other reason; the detail is all we know. */
  | 'provider_error';

export type ClassifiedProviderError = {
  class: ProviderFailureClass;
  /** HTTP status where there was one; null for a transport failure. */
  status: number | null;
  /**
   * Provider-facing text. It can echo a request header, so every caller passes
   * it through `ProviderSecrets.redact` before it is stored or logged (M7.2).
   */
  detail: string;
};

/** undici and node:net failure codes — a request that never got an answer. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * A model id the endpoint does not serve, phrased a dozen ways in the wild.
 *
 * The gap between `model` and the failure phrase stops at a sentence boundary,
 * so an unrelated later sentence cannot be read as a verdict about the model —
 * but a dot *inside* a token is not a boundary, because dotted model ids
 * (`llama-3.1-8b`, `gpt-4.1`) are the naming convention of the field, not an
 * edge case.
 */
const MODEL_MISSING =
  /model(?:[^.]|\.(?!\s|$)){0,40}(not\s*found|does\s*not\s*exist|not\s*exist|unknown|invalid|unavailable)|(unknown|invalid|unsupported)\s*model|no\s*such\s*model/i;

function chain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  let current = error;
  // A fetch failure arrives as Error -> cause -> cause; three links is deeper
  // than undici nests and terminates on anything cyclical.
  for (let i = 0; i < 4 && current && typeof current === 'object'; i += 1) {
    seen.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return seen;
}

function statusOf(error: unknown): number | null {
  for (const link of chain(error)) {
    const status = (link as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/**
 * Both SDKs wrap a round trip that never completed in their own error class and
 * give it this one message. Matching the name keeps this file duck-typed (see
 * the header); the message is the fallback for a throw that lost its class.
 */
const CONNECTION_ERROR_NAMES = new Set(['APIConnectionError', 'APIConnectionTimeoutError']);

function isSdkConnectionError(error: unknown): boolean {
  return chain(error).some((link) => {
    const name = (link as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === 'string' && CONNECTION_ERROR_NAMES.has(name)) return true;
    const message = (link as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() === 'Connection error.';
  });
}

function isTransport(error: unknown): boolean {
  return chain(error).some((link) => {
    const code = (link as { code?: unknown }).code;
    return typeof code === 'string' && TRANSPORT_CODES.has(code);
  });
}

export function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  const status = statusOf(error);
  const detail = detailOf(error);

  // Nothing answered. Only two things prove that: a transport code, or the
  // SDKs' own connection error. Everything else that lacks a status merely
  // failed *somewhere*, which is a different claim (see the return below).
  if (status === null && (isTransport(error) || isSdkConnectionError(error))) {
    return { class: 'unreachable', status: null, detail };
  }
  if (status === 401 || status === 403) {
    return { class: 'unauthenticated', status, detail };
  }
  // 404 is the common answer; some OpenAI-compatible servers say 400 or 422 and
  // put the reason in the body, which is what the SDK puts in the message.
  if (status === 404 || (status !== null && status < 500 && MODEL_MISSING.test(detail))) {
    return { class: 'model_not_found', status, detail };
  }
  // Everything left over: a status with no rule, or a throw carrying no status
  // at all — a success body the SDK could not assemble, a mid-stream decode
  // failure, an adapter bug, a non-Error throw. None of those is evidence that
  // nothing answered, and reporting `unreachable` for an endpoint that did
  // answer is the most misleading verdict an operator can be handed. So they
  // land here, where `reachable` and `authenticated` keep standing and the
  // detail is the whole of what is known (M7-FU2, #43).
  return { class: 'provider_error', status, detail };
}
