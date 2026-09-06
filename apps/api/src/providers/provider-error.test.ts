/**
 * Classification (M7-FU2, #43). The four classes drive two operator-facing
 * surfaces — M7.5's per-field verdict and M7.9's log line — so the cost of a
 * wrong class is an operator sent to chase the wrong thing. These cases pin the
 * two directions that were wrong: claiming nothing answered when something did,
 * and failing to recognise a model id with a dot in it.
 */
import { describe, expect, it } from 'vitest';
import { classifyProviderError } from './provider-error';

/** An SDK connection error, duck-typed the way the module reads it. */
class APIConnectionError extends Error {
  constructor() {
    super('Connection error.');
  }
}

describe('classifyProviderError', () => {
  describe('an endpoint that answered is never reported unreachable (AC-1)', () => {
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

  describe('nothing answered is still reported unreachable (AC-2)', () => {
    it('recognises a transport code nested under cause', () => {
      const error = Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          code: 'ECONNREFUSED',
        }),
      });
      expect(classifyProviderError(error)).toMatchObject({ class: 'unreachable', status: null });
    });

    it('recognises the SDKs own connection error by class name', () => {
      expect(classifyProviderError(new APIConnectionError()).class).toBe('unreachable');
    });

    it('recognises it by message when the class did not survive', () => {
      expect(classifyProviderError(new Error('Connection error.')).class).toBe('unreachable');
    });
  });

  describe('a model id with a dot in it (AC-3)', () => {
    // 404 covers the OpenAI-hosted case; these are the OpenAI-*compatible*
    // servers that answer 400 or 422 and put the reason in the body.
    const missing = { status: 400 };

    it('matches a dotted model id between "model" and the failure phrase', () => {
      const error = Object.assign(new Error('The model `llama-3.1-8b` does not exist'), missing);
      expect(classifyProviderError(error).class).toBe('model_not_found');
    });

    it('still matches the dot-free phrasing', () => {
      const error = Object.assign(new Error('The model `gpt-oss` does not exist'), missing);
      expect(classifyProviderError(error).class).toBe('model_not_found');
    });

    it('does not match across a sentence boundary', () => {
      // Two unrelated sentences. Widening the gap must not turn every 4xx body
      // that happens to say "model" early and "invalid" later into a model id
      // verdict.
      const error = Object.assign(
        new Error('The model served fine. Your request body was invalid'),
        missing,
      );
      expect(classifyProviderError(error).class).toBe('provider_error');
    });
  });

  describe('the classes that already worked', () => {
    it.each([
      [401, 'unauthenticated'],
      [403, 'unauthenticated'],
      [404, 'model_not_found'],
      [500, 'provider_error'],
      [429, 'provider_error'],
    ])('maps status %i to %s', (status, expected) => {
      const error = Object.assign(new Error('nope'), { status });
      expect(classifyProviderError(error).class).toBe(expected);
    });
  });
});
