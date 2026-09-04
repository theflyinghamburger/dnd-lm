/**
 * DM turn telemetry (M6.9, NFR-505). Spans go to the SDK's global tracer
 * provider: with no exporter registered they cost nothing, and an operator who
 * points an SDK at a collector gets every resolution span without a code
 * change. What a span carries: the identity (campaign/session/resolution/
 * trigger), per-layer token counts, provider/cache/cost tokens — never
 * narration, prompt or state.
 */
import { context, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

export const tracer = trace.getTracer('dnd-lm.dm');

export type DmSpanAttrs = Record<string, string | number>;

/**
 * Runs a turn (or a phase of one) under a span. Exceptions are recorded and
 * rethrown — a failed resolution must fail loudly, not just end a span.
 */
export async function withSpan<T>(
  name: string,
  attrs: DmSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    setAttrs(span, attrs);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setAttrs(span: Span, attrs: DmSpanAttrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'number' && Number.isFinite(value)) span.setAttribute(key, value);
    else if (typeof value === 'string') span.setAttribute(key, value);
  }
}

/**
 * Prices a completion. Only models with a known rate are priced (the operator
 * can serve other models, and a guessed price is a lie in a cost report);
 * everything else reports null and the token counts carry the story.
 */
const US_PER_MILLION: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
};

export function estimateUsd(
  model: string,
  tokens: { input: number; output: number; cacheRead: number },
): number | null {
  const rate = US_PER_MILLION[model.toLowerCase()];
  if (!rate) return null;
  return (
    (tokens.input / 1e6) * rate.input +
    (tokens.output / 1e6) * rate.output +
    (tokens.cacheRead / 1e6) * rate.cacheRead
  );
}

/** Re-exported so callers can nest contexts without importing the SDK twice. */
export { context as otelContext };
