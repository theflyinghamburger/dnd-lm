/**
 * Anthropic adapter (M6.3). Official SDK, no LangChain layer: streaming,
 * `thinking: { type: 'adaptive' }` (no `budget_tokens`), and a prompt-cached
 * stable prefix — the DM contract + SRD block is one cached text block, so a
 * session's turn after the first reuses it instead of re-sending the ruleset.
 *
 * The model's own output shape (prose + a ```dm-json control block) and its
 * tool channel live in the DM contract, not in this file.
 */
import Anthropic from '@anthropic-ai/sdk';
import { checkBaseUrl, guardedFetch, providerUrlEnv } from '../providers/base-url';
import {
  type DmCompletion,
  type DmProvider,
  type DmProviderConfig,
  type DmRequest,
  type DmUsage,
} from './provider';

export class AnthropicProvider implements DmProvider {
  readonly kind = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly config: DmProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl, fetch: guardedFetch() } : {}),
    });
  }

  get model(): string {
    return this.config.model;
  }

  async generate(req: DmRequest, onDelta?: (chunk: string) => void): Promise<DmCompletion> {
    // M7.7 (M7.3's documented depth difference): the SDK resolves DNS itself,
    // so the request-time wall here re-checks the stored URL against the
    // deployment's current policy just before the call. A host that rebinding
    // points at a forbidden range between this check and the SDK's connect is
    // the accepted gap openai_compatible's resolved-IP path does not have.
    if (this.config.baseUrl) {
      const verdict = await checkBaseUrl(this.config.baseUrl, providerUrlEnv());
      if (!verdict.ok) {
        return { kind: 'error', message: `base_url no longer permitted: ${verdict.reason}` };
      }
    }
    const stream = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      thinking: { type: 'adaptive' },
      // One cache break at the end of the stable prefix: everything before the
      // per-turn prompt is byte-identical across a session's turns.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.prompt }],
      stream: true,
    });

    let raw = '';
    const usage: DmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    for await (const event of stream) {
      if (event.type === 'message_start') {
        usage.inputTokens = event.message.usage.input_tokens;
        usage.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
      } else if (event.type === 'content_block_delta') {
        // Thinking deltas are the model's private scratch; only text is narration.
        if (event.delta.type === 'text_delta') {
          raw += event.delta.text;
          onDelta?.(event.delta.text);
        }
      } else if (event.type === 'message_delta') {
        usage.outputTokens = event.usage.output_tokens;
      }
    }

    return { kind: 'ok', raw, usage };
  }
}
