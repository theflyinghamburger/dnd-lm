/**
 * The DM provider boundary (M6.3, FR-501).
 *
 * One narrow interface, deliberately NOT a LangChain `ChatModel`: both adapters
 * speak raw provider APIs, and the tool channel is *structured output*, not
 * native provider tool-calls. The DM emits a prose narration followed by a
 * fenced JSON block; parsing and validation happen after, in the graph (M6.6).
 * The consequence is what the M7.5 contract suite measures: any
 * OpenAI-compatible model is judged on the same pass/fail bars as the flagship
 * one, because neither gets a privileged API feature.
 */
import { type DmOutput, DmOutput as DmOutputSchema } from '@dnd-lm/contracts';
import { AnthropicProvider } from './anthropic.adapter';
import { OpenAICompatibleProvider } from './openai-compatible.adapter';

/** The fence the DM contract makes the control block open with. */
export const DM_JSON_MARKER = '```dm-json';

export type DmUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads; zero where the provider has no cache to read. */
  cacheReadTokens: number;
};

export type DmRequest = {
  /** Stable prefix: the DM contract + SRD ruleset. Never carries prose. */
  system: string;
  /** The per-turn prompt: structured state, untrusted layers, transcript. */
  prompt: string;
  maxTokens: number;
};

export type DmCompletion =
  { kind: 'ok'; raw: string; usage: DmUsage } | { kind: 'error'; message: string };

export type DmProvider = {
  kind: string;
  model: string;
  generate(req: DmRequest, onDelta?: (chunk: string) => void): Promise<DmCompletion>;
};

/**
 * Splits a completion into its narration and control block (M6.6). Everything
 * before the marker is narration; the block's contents must parse as
 * `DmOutput`. A completion without the block is given one lenient chance — the
 * whole raw body is tried as JSON — because local models drop the fence more
 * than they should, and the retry path exists for exactly that.
 */
export function parseDmOutput(raw: string): { narration: string; output: DmOutput | null } {
  const at = raw.indexOf(DM_JSON_MARKER);
  const narration = (at === -1 ? raw : raw.slice(0, at)).replace(/\s+$/, '');

  const start = at === -1 ? raw.trimStart().indexOf('{') : raw.indexOf('{', at);
  const end = at === -1 ? raw.lastIndexOf('}') : raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { narration, output: null };

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    const checked = DmOutputSchema.safeParse(parsed);
    return { narration, output: checked.success ? checked.data : null };
  } catch {
    return { narration, output: null };
  }
}

/**
 * The provisional-narration gate (M6.6). Emits chunks as they stream until the
 * control-block marker appears, then goes quiet — the JSON block is never
 * streamed to the table. The last marker-length tail is held back while it
 * could still be the marker prefix, so clients never see a half-typed fence.
 */
export function makeDeltaGate(onDelta: (chunk: string) => void): {
  push(chunk: string): void;
  end(): void;
} {
  let held = '';
  let sealed = false;
  return {
    push(chunk) {
      if (sealed) return;
      held += chunk;
      const at = held.indexOf(DM_JSON_MARKER);
      if (at !== -1) {
        if (at > 0) onDelta(held.slice(0, at));
        sealed = true;
        held = '';
      } else {
        const safe = held.length - DM_JSON_MARKER.length;
        if (safe > 0) {
          onDelta(held.slice(0, safe));
          held = held.slice(safe);
        }
      }
    },
    end() {
      // No marker in the whole completion: it is all narration (and a failed
      // resolution, which is retracted separately).
      if (!sealed && held.length > 0) {
        onDelta(held);
        held = '';
      }
    },
  };
}

export type DmProviderConfig = {
  kind: 'anthropic' | 'openai_compatible';
  baseUrl: string | null;
  apiKey: string;
  model: string;
  maxTokens: number;
};

/**
 * Runtime configuration (MVP.md §2: providers configured at runtime, M6 env,
 * M7 moves it to per-connection rows). An unset or unrecognized kind is not a
 * crash — it is the typed `NO_PROVIDER_CONFIGURED` failure a session sees.
 */
export function readDmProviderConfig(): DmProviderConfig | null {
  const kind = process.env.DM_PROVIDER_KIND;
  if (kind !== 'anthropic' && kind !== 'openai_compatible') return null;
  const apiKey = process.env.DM_PROVIDER_API_KEY;
  if (!apiKey) return null;
  return {
    kind,
    baseUrl: process.env.DM_PROVIDER_BASE_URL || null,
    apiKey,
    model: process.env.DM_PROVIDER_MODEL || (kind === 'anthropic' ? 'claude-opus-5' : 'gpt-4o'),
    maxTokens: Number(process.env.DM_PROVIDER_MAX_TOKENS) || 4096,
  };
}

export function buildDmProvider(config: DmProviderConfig): DmProvider {
  return config.kind === 'anthropic'
    ? new AnthropicProvider(config)
    : new OpenAICompatibleProvider(config);
}
