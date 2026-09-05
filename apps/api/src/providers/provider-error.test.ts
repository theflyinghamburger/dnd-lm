import { describe, expect, it } from 'vitest';
import { classifyProviderError } from './provider-error';

/** The shape both SDKs throw: a class of their own with an HTTP `status`. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** What a local endpoint that is not listening produces, nesting and all. */
function fetchFailure(code: string): Error {
  return Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code }),
  });
}

describe('classifyProviderError (M7.5)', () => {
  it('separates a rejected credential from an absent endpoint', () => {
    expect(classifyProviderError(apiError(401, 'invalid api key')).class).toBe('unauthenticated');
    expect(classifyProviderError(apiError(403, 'forbidden')).class).toBe('unauthenticated');
    expect(classifyProviderError(fetchFailure('ECONNREFUSED')).class).toBe('unreachable');
    expect(classifyProviderError(fetchFailure('ENOTFOUND')).class).toBe('unreachable');
  });

  it('reads a missing model from the status, or from the body when the status is vaguer', () => {
    expect(classifyProviderError(apiError(404, 'not found')).class).toBe('model_not_found');
    expect(classifyProviderError(apiError(400, 'The model `gpt-9` does not exist')).class).toBe(
      'model_not_found',
    );
    expect(classifyProviderError(apiError(422, 'unknown model: llama-99')).class).toBe(
      'model_not_found',
    );
  });

  it('does not read a 500 as a missing model, whatever the body says', () => {
    const classified = classifyProviderError(apiError(500, 'model not found in shard'));
    expect(classified.class).toBe('provider_error');
    expect(classified.status).toBe(500);
  });

  it('treats an SDK connection wrapper with no status as unreachable', () => {
    expect(classifyProviderError(new Error('Connection error.')).class).toBe('unreachable');
  });

  it('carries the provider text through for the caller to redact', () => {
    expect(classifyProviderError(apiError(401, 'key sk-abc rejected')).detail).toContain('sk-abc');
  });
});
