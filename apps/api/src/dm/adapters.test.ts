import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.adapter';
import { OpenAICompatibleProvider } from './openai-compatible.adapter';
import { type DmProvider, type DmProviderConfig, type DmRequest } from './provider';

/**
 * P4.1.0 (#65): `DmRequest.maxTokens` reaches the wire. The connection row's
 * `max_tokens` stays the default for a request that asks for none (0/absent).
 * The SDK's `create` is stubbed, so nothing leaves the process.
 */
const config = (kind: DmProviderConfig['kind']): DmProviderConfig => ({
  kind,
  baseUrl: null,
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 1024,
});

const empty = async function* () {};

const adapters: Array<[string, () => { provider: DmProvider; create: ReturnType<typeof vi.fn> }]> =
  [
    [
      'anthropic',
      () => {
        const provider = new AnthropicProvider(config('anthropic'));
        const client = (provider as unknown as { client: { messages: { create: unknown } } })
          .client;
        const create = vi.fn(async () => empty());
        client.messages.create = create;
        return { provider, create };
      },
    ],
    [
      'openai_compatible',
      () => {
        const provider = new OpenAICompatibleProvider(config('openai_compatible'));
        const client = (
          provider as unknown as { client: { chat: { completions: { create: unknown } } } }
        ).client;
        const create = vi.fn(async () => empty());
        client.chat.completions.create = create;
        return { provider, create };
      },
    ],
  ];

describe.each(adapters)('%s adapter honours DmRequest.maxTokens', (_kind, make) => {
  const sent = async (maxTokens: number | undefined) => {
    const { provider, create } = make();
    await provider.generate({ system: 's', prompt: 'p', maxTokens } as DmRequest);
    return (create.mock.calls[0]![0] as { max_tokens: number }).max_tokens;
  };

  it('sends the requested ceiling', async () => {
    expect(await sent(4000)).toBe(4000);
    expect(await sent(256)).toBe(256);
  });

  it("falls back to the connection's max_tokens for 0 or absent", async () => {
    expect(await sent(0)).toBe(1024);
    expect(await sent(undefined)).toBe(1024);
  });
});
