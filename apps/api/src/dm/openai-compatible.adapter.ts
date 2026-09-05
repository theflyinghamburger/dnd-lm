/**
 * OpenAI-compatible adapter (M6.3). Its own client in its own file, driven
 * entirely by the configured host URL and key — point it at an OpenAI-hosted
 * endpoint, llama.cpp, vLLM, or whatever M7.1 records as a connection. It is
 * never pointed at Anthropic.
 *
 * `stream_options.include_usage` is the OpenAI API contract for per-stream
 * token accounting (M6.9); a server that cannot serve it fails the contract
 * suite, which is exactly the point of one (M7.5).
 */
import OpenAI from 'openai';
import { resolvedIpFetch } from '../providers/base-url';
import {
  type DmCompletion,
  type DmProvider,
  type DmProviderConfig,
  type DmRequest,
  type DmUsage,
} from './provider';

export class OpenAICompatibleProvider implements DmProvider {
  readonly kind = 'openai_compatible';
  private readonly client: OpenAI;

  constructor(private readonly config: DmProviderConfig) {
    this.client = new OpenAI({
      // The SDK rejects a missing credential. A keyless local endpoint ignores
      // auth entirely, so a placeholder is what crosses to it — never a secret.
      apiKey: config.apiKey || 'keyless-local',
      baseURL: config.baseUrl ?? undefined,
      // M7.7: the user-chosen host is fetched through the resolved-IP wall —
      // the connect target is the address M7.3's check just approved.
      ...(config.baseUrl ? { fetch: resolvedIpFetch() } : {}),
    });
  }

  get model(): string {
    return this.config.model;
  }

  async generate(req: DmRequest, onDelta?: (chunk: string) => void): Promise<DmCompletion> {
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
    });

    let raw = '';
    const usage: DmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        raw += delta.content;
        onDelta?.(delta.content);
      }
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
    }

    return { kind: 'ok', raw, usage };
  }
}
