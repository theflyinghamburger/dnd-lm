/**
 * *Test connection* (M7.5, #23) — the operator-facing answer to "will my model
 * actually work here?", asked on demand and answered by one real call.
 *
 * The call goes through the same row->provider path a DM turn uses
 * (`sourceFromRow`), and the reply is parsed by the same `parseDmOutput` the
 * graph uses, because the interesting failure is not a dead socket: it is an
 * endpoint that is reachable, authenticated, serving the configured model, and
 * still unable to produce the structured block the DM contract requires (M6.6).
 * A test that only proved HTTP would reassure about the wrong thing.
 *
 * Every press spends money or compute, so it is rate-limited per connection and
 * runs only from the explicit admin POST — never from a page load or a save.
 */
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectionTestResult } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { providerConnections } from '../db/schema';
import { parseDmOutput } from '../dm/provider';
import { TokenBucket } from '../session/token-bucket';
import { BaseUrlService } from './base-url.service';
import { ProviderConnectionsService } from './connections.service';
import { classifyProviderError, type ProviderFailureClass } from './provider-error';
import { ProviderSecrets } from './provider-secrets.service';

const TESTS_PER_MINUTE = 5;
/** A handful of tokens: enough for one sentence and the smallest legal block. */
const TEST_MAX_TOKENS = 256;
/** The endpoint writes this detail into our row; it does not get to choose how much. */
const DETAIL_MAX = 500;

/**
 * The DM contract in its smallest honest form. Not the real system prompt —
 * that carries the whole ruleset (M6.4) and this must stay cheap — but the same
 * demand: prose, then a fenced control block `parseDmOutput` can read.
 */
const TEST_SYSTEM = [
  'You are a Dungeon Master. Reply with one short sentence of narration, then a',
  'fenced block that starts with ```dm-json and contains exactly this JSON:',
  '{"narration":"<your sentence>","addressed_to":["party"],"tool_requests":[],',
  '"proposed_state_changes":[],"memory_candidates":[],"next_state":"WAITING_FOR_PLAYERS"}',
  'Write nothing after the closing fence.',
].join('\n');

const TEST_PROMPT = 'Connection test. Narrate: the tavern door swings open.';

/**
 * What each failure class establishes, and nothing beyond it. A 401 says the
 * endpoint answered — so `reachable` stands and only `authenticated` falls.
 * `provider_error` (a 500, a malformed body) keeps `authenticated`, because the
 * request got past the credential check to fail, and drops `modelExists`: the
 * call never demonstrated the model, and a field that guesses is worse than a
 * field that admits it does not know.
 */
const FIELDS: Record<
  ProviderFailureClass,
  Pick<ConnectionTestResult, 'reachable' | 'authenticated' | 'modelExists'>
> = {
  unreachable: { reachable: false, authenticated: false, modelExists: false },
  unauthenticated: { reachable: true, authenticated: false, modelExists: false },
  model_not_found: { reachable: true, authenticated: true, modelExists: false },
  provider_error: { reachable: true, authenticated: true, modelExists: false },
};

@Injectable()
export class ConnectionTestService {
  /**
   * ponytail: in-process buckets, so a multi-process deployment grants the
   * limit per process. For a button an admin presses this is a cost ceiling,
   * not a security boundary; a shared limiter is worth it only once there is a
   * second process. The map holds one small object per tested connection.
   */
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connections: ProviderConnectionsService,
    private readonly secrets: ProviderSecrets,
    private readonly urls: BaseUrlService,
  ) {}

  private bucket(id: string): TokenBucket {
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = new TokenBucket(TESTS_PER_MINUTE, TESTS_PER_MINUTE / 60);
      this.buckets.set(id, bucket);
    }
    return bucket;
  }

  /**
   * One test. A disabled row is testable on purpose: an admin has to be able
   * to prove a draft connection works before enabling it for a table.
   */
  async test(id: string): Promise<ConnectionTestResult> {
    // Taken before anything else, so a refused press cannot reach the provider.
    if (!this.bucket(id).take()) {
      throw new HttpException(
        { code: 'TEST_RATE_LIMITED', limit: TESTS_PER_MINUTE, window: '1 minute' },
        429,
      );
    }

    const [row] = await this.db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, id))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });

    const result = await this.run(row);
    await this.db
      .update(providerConnections)
      .set({ lastTestResult: result })
      .where(eq(providerConnections.id, id));
    return result;
  }

  private async run(row: typeof providerConnections.$inferSelect): Promise<ConnectionTestResult> {
    const at = new Date().toISOString();
    const sourced = await this.connections.sourceFromRow(row);
    if (!sourced) {
      // Only the SSRF wall refuses a row (M7.3). Ask it again for the reason —
      // on the failure path only, where a second resolve costs nothing.
      const verdict = await this.urls.validate(row.baseUrl);
      return {
        ...FIELDS.unreachable,
        structuredOutput: false,
        latencyMs: 0,
        detail: `base URL is not permitted: ${verdict.ok ? 'rejected at request time' : verdict.reason}`,
        at,
      };
    }

    const started = Date.now();
    try {
      const completion = await sourced.provider.generate({
        system: TEST_SYSTEM,
        prompt: TEST_PROMPT,
        maxTokens: TEST_MAX_TOKENS,
      });
      const latencyMs = Date.now() - started;

      if (completion.kind === 'error') {
        // The adapters return this (rather than throwing) when the request-time
        // URL re-check refuses the call, so nothing was sent.
        return {
          ...FIELDS.unreachable,
          structuredOutput: false,
          latencyMs,
          detail: this.redact(completion.message, sourced.config.apiKey),
          at,
        };
      }

      const { output } = parseDmOutput(completion.raw);
      return {
        reachable: true,
        authenticated: true,
        // The endpoint accepted the configured model id. Whether it then served
        // that exact model is not observable without a second round trip no
        // provider guarantees, and the field does not pretend otherwise.
        modelExists: true,
        structuredOutput: output !== null,
        latencyMs,
        detail: output === null ? 'the endpoint answered without a parseable dm-json block' : null,
        at,
      };
    } catch (error) {
      const classified = classifyProviderError(error);
      return {
        ...FIELDS[classified.class],
        structuredOutput: false,
        latencyMs: Date.now() - started,
        detail: this.redact(classified.detail, sourced.config.apiKey),
        at,
      };
    }
  }

  /**
   * Provider text can echo the request's own auth header (M7.2, NFR-305), and
   * it is attacker-influenced data on its way into a row an admin page will
   * render: a hostile endpoint answering a megabyte of error is otherwise a
   * free write. Redact first, then cap.
   */
  private redact(text: string, apiKey: string): string {
    const clean = this.secrets.redact(text, [apiKey]);
    return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX)}…` : clean;
  }
}
