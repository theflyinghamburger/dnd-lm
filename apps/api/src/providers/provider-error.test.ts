/**
 * Classification (M7.5, extended by M7-FU2 #43).
 *
 * The four classes drive two operator-facing surfaces — M7.5's per-field verdict
 * and M7.9's log line — so the cost of a wrong class is an operator sent to
 * chase the wrong thing. Two directions matter equally and are tested as a pair:
 * claiming nothing answered when something did, and claiming a dead socket was a
 * live one.
 */
import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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

  describe('an endpoint that answered is never reported unreachable (M7-FU2 AC-1)', () => {
    it('classifies a status-less, non-transport throw as provider_error', () => {
      // A success body the SDK could not assemble: the exchange happened.
      const error = new Error('Unexpected end of JSON input');
      expect(classifyProviderError(error)).toEqual({
        class: 'provider_error',
        status: null,
        detail: 'Unexpected end of JSON input',
      });
    });

    it('classifies an adapter bug the same way, not as a dead socket', () => {
      const error = new TypeError("Cannot read properties of undefined (reading 'content')");
      expect(classifyProviderError(error).class).toBe('provider_error');
    });

    it('classifies a non-Error throw as provider_error', () => {
      expect(classifyProviderError('boom').class).toBe('provider_error');
    });
  });

  describe('nothing answered is still reported unreachable (M7-FU2 AC-2)', () => {
    // The real classes, not a stand-in. Both SDKs name them identically and
    // neither sets `name` on the instance, so `constructor.name` is the only
    // signature there is — a fact worth failing on if either SDK changes it.
    it.each([
      ['anthropic', new APIConnectionError({})],
      ['anthropic timeout', new APIConnectionTimeoutError({})],
      ['openai', new OpenAI.APIConnectionError({})],
      ['openai timeout', new OpenAI.APIConnectionTimeoutError({})],
    ])('recognises the %s SDK connection error', (_label, error) => {
      expect(error.status).toBeUndefined();
      expect(classifyProviderError(error).class).toBe('unreachable');
    });

    // The two signals are pinned apart, because together they hide each other:
    // every stock SDK error satisfies both, so a test using only those stays
    // green with either check deleted. Here the class carries a message the
    // message set does not know...
    it('recognises the SDK class even when the message is not the stock one', () => {
      const error = new APIConnectionError({ message: 'socket hang up' });
      expect(classifyProviderError(error).class).toBe('unreachable');
    });

    it('recognises a transport code nested under cause', () => {
      expect(classifyProviderError(fetchFailure('ECONNREFUSED'))).toMatchObject({
        class: 'unreachable',
        status: null,
      });
    });

    // ...and here the message arrives on a plain Error, the class having been
    // lost on the way (a rethrow, a serialisation boundary).
    it.each(['Connection error.', 'Request timed out.'])(
      'recognises %j when the class did not survive',
      (message) => {
        expect(classifyProviderError(new Error(message)).class).toBe('unreachable');
      },
    );
  });

  describe('a model id with a dot in it (M7-FU2 AC-3)', () => {
    it('matches a dotted model id between "model" and the failure phrase', () => {
      const error = apiError(400, 'The model `llama-3.1-8b` does not exist');
      expect(classifyProviderError(error).class).toBe('model_not_found');
    });

    it('does not match across a sentence boundary', () => {
      // Widening the gap must not turn every 4xx body that says "model" early
      // and "invalid" later into a model id verdict.
      const error = apiError(400, 'The model served fine. Your request body was invalid');
      expect(classifyProviderError(error).class).toBe('provider_error');
    });

    it('leaves the 500 boundary alone for a dotted body too', () => {
      // The status rule outranks the body rule in both directions: below 500 the
      // body can name a missing model, at 500 and above it cannot.
      const error = apiError(503, 'The model `llama-3.1-8b` does not exist');
      expect(classifyProviderError(error).class).toBe('provider_error');
    });
  });
});
