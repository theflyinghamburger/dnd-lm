import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminConnection,
  CreateConnectionRequest,
  HostConnection,
  UpdateConnectionRequest,
} from '@dnd-lm/contracts';
import { ConnectionTestResult } from '@dnd-lm/contracts';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaigns, providerConnectionAudit, providerConnections } from '../db/schema';
import { buildDmProvider, type SourcedProvider } from '../dm/provider';
import type { Tx } from '../session/session.service';
import { BaseUrlService } from './base-url.service';
import { ProviderSecrets } from './provider-secrets.service';

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
type Row = ProviderConnectionRow;

function toAdmin(row: Row): AdminConnection {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.baseUrl,
    apiKeyLast4: row.apiKeyLast4,
    modelId: row.modelId,
    maxTokens: row.maxTokens,
    enabled: row.enabled,
    // A row written before M7.5, or by a future shape this build does not
    // know, reads as "never tested" rather than failing the whole list.
    lastTest: parseLastTest(row.lastTestResult),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** DTO field -> the column name the audit records it under. */
const UPDATABLE = [
  ['label', 'label'],
  ['baseUrl', 'base_url'],
  ['modelId', 'model_id'],
  ['maxTokens', 'max_tokens'],
  ['enabled', 'enabled'],
] as const satisfies ReadonlyArray<readonly [keyof UpdateConnectionRequest & keyof Row, string]>;

function createdFields(input: CreateConnectionRequest): string[] {
  const fields = ['label', 'kind', 'base_url', 'model_id'];
  if (input.maxTokens !== undefined) fields.push('max_tokens');
  if (input.apiKey) fields.push('api_key');
  return fields;
}

/**
 * "Who turned this off" is the question the audit exists to answer, so an
 * `enabled` flip is its own action rather than a generic `updated` whose
 * changed fields have to be read to find out.
 */
function actionFor(
  was: boolean,
  next: boolean | undefined,
): (typeof providerConnectionAudit.$inferInsert)['action'] {
  if (next === undefined || next === was) return 'updated';
  return next ? 'enabled' : 'disabled';
}

function parseLastTest(stored: unknown): AdminConnection['lastTest'] {
  const parsed = ConnectionTestResult.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/**
 * Connection reads and writes (M7.4). The admin shape and the redacted host
 * shape come out of the same rows — the host projection simply never selects
 * the URL or the key columns, so there is nothing to filter out afterwards.
 *
 * These are plain DB transactions, deliberately NOT `runCommand` callers: a
 * connection row is not a session mutation (MVP.md M7.4 process, step 2).
 */
@Injectable()
export class ProviderConnectionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly secrets: ProviderSecrets,
    private readonly urls: BaseUrlService,
  ) {}

  /** The host-facing list: enabled connections, redacted (id, label, kind, model). */
  async listForHosts(): Promise<HostConnection[]> {
    const rows = await this.db
      .select({
        id: providerConnections.id,
        label: providerConnections.label,
        kind: providerConnections.kind,
        modelId: providerConnections.modelId,
        enabled: providerConnections.enabled,
      })
      .from(providerConnections)
      .where(eq(providerConnections.enabled, true))
      .orderBy(providerConnections.label);
    return rows;
  }

  async listForAdmin(): Promise<AdminConnection[]> {
    const rows = await this.db
      .select()
      .from(providerConnections)
      .orderBy(providerConnections.label);
    return rows.map(toAdmin);
  }

  async getForAdmin(id: string): Promise<AdminConnection> {
    const [row] = await this.db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, id))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
    return toAdmin(row);
  }

  async create(userId: string, input: CreateConnectionRequest): Promise<AdminConnection> {
    const verdict = await this.urls.validate(input.baseUrl);
    if (!verdict.ok) {
      // Refused before the transaction opens, so a rejected URL leaves no
      // audit row behind (M7.8): the log records changes, not attempts.
      throw new BadRequestException({ code: 'BASE_URL_REJECTED', reason: verdict.reason });
    }
    const key = input.apiKey ? this.secrets.encrypt(input.apiKey) : null;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(providerConnections)
        .values({
          label: input.label,
          kind: input.kind,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          maxTokens: input.maxTokens ?? 1024,
          createdBy: userId,
          apiKeyCiphertext: key?.apiKeyCiphertext ?? null,
          apiKeyNonce: key?.apiKeyNonce ?? null,
          apiKeyLast4: key?.apiKeyLast4 ?? null,
        })
        .returning();
      if (!row) throw new Error('connection insert returned no row');
      await this.audit(tx, row.id, userId, 'created', createdFields(input));
      return toAdmin(row);
    });
  }

  async update(
    id: string,
    userId: string,
    input: UpdateConnectionRequest,
  ): Promise<AdminConnection> {
    if (input.baseUrl !== undefined) {
      const verdict = await this.urls.validate(input.baseUrl);
      if (!verdict.ok) {
        throw new BadRequestException({ code: 'BASE_URL_REJECTED', reason: verdict.reason });
      }
    }

    return this.db.transaction(async (tx) => {
      // Locked, not merely read. The UPDATE below takes the row lock anyway, so
      // a concurrent write is never lost -- but an unlocked diff read sees a
      // snapshot that writer can invalidate before the write lands, and the
      // audit row is computed from the diff. Two PATCHes renaming a row to the
      // same value would each record having changed the label, when only the
      // first one did. The audit is the record of what happened; it does not get
      // to describe an event that did not (M7-FU2, #44).
      const [before] = await tx
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, id))
        .for('update')
        .limit(1);
      if (!before) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });

      // The diff is against the stored row, not against the request's keys: a
      // PATCH that re-sends the current label changed nothing, and the audit
      // says so (M7.8).
      const set: Partial<Row> = { updatedAt: new Date() };
      const changed: string[] = [];
      for (const [field, column] of UPDATABLE) {
        const next = input[field];
        if (next === undefined || next === before[field]) continue;
        (set as Record<string, unknown>)[field] = next;
        changed.push(column);
      }
      // A test result attests one configuration (M7.5). Move the endpoint or
      // the model and the stored verdict stops being about the row it sits on,
      // so it is cleared rather than left claiming `authenticated: true` for a
      // setup that no longer exists. Renaming or enabling changes nothing it
      // measured, and re-sending an unchanged value is not a change at all.
      if (changed.includes('base_url') || changed.includes('model_id')) {
        set.lastTestResult = null;
      }

      const [row] = await tx
        .update(providerConnections)
        .set(set)
        .where(eq(providerConnections.id, id))
        .returning();
      if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
      await this.audit(tx, id, userId, actionFor(before.enabled, input.enabled), changed);
      return toAdmin(row);
    });
  }

  /**
   * Refused — with the campaign names named — while any campaign still points
   * at this connection (the MVP.md default, chosen over silently clearing the
   * reference: an admin delete should not quietly rewire a campaign's DM).
   */
  async delete(id: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inUseBy = await tx
        .select({ id: campaigns.id, name: campaigns.name })
        .from(campaigns)
        .where(sql`${campaigns.settings}->>'provider_connection_id' = ${id}`);
      if (inUseBy.length > 0) {
        throw new ConflictException({
          code: 'CONNECTION_IN_USE',
          campaigns: inUseBy.map((c) => ({ id: c.id, name: c.name })),
        });
      }
      const [row] = await tx
        .delete(providerConnections)
        .where(eq(providerConnections.id, id))
        .returning();
      if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
      // Written after the delete and kept afterwards: the audit table has no
      // foreign key to the row it audits precisely so this survives (M7.8).
      await this.audit(tx, id, userId, 'deleted', []);
    });
  }

  /**
   * Row -> the provider a DM turn would build from it (M7.7's path, extracted
   * in M7.5 so the *Test connection* action exercises it rather than a second
   * client of its own). Null means the row cannot be used: the URL is no
   * longer permitted by the deployment's SSRF policy, which is state that
   * moves after a row is written.
   */
  async sourceFromRow(row: Row): Promise<SourcedProvider | null> {
    const verdict = await this.urls.validate(row.baseUrl);
    if (!verdict.ok) return null;
    const config = {
      kind: row.kind,
      // null here: a keyless endpoint (M7.3 local inference); the adapters
      // treat an empty key as "send no credential of consequence".
      apiKey: this.secrets.decrypt(row) ?? '',
      baseUrl: row.baseUrl,
      model: row.modelId,
      maxTokens: row.maxTokens,
    };
    return { provider: buildDmProvider(config), config, connectionId: row.id };
  }

  /** M7.2's re-encrypt under a fresh nonce; the row must exist first. */
  async replaceKey(id: string, userId: string, apiKey: string): Promise<AdminConnection> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(eq(providerConnections.id, id))
        .limit(1);
      if (!before) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
      await this.secrets.replaceKey(id, apiKey, tx);
      // Same reason as `update`: the previous key's verdict is not this key's.
      await tx
        .update(providerConnections)
        .set({ lastTestResult: null })
        .where(eq(providerConnections.id, id));
      // The name of the field, never a fragment of its value (NFR-305).
      await this.audit(tx, id, userId, 'replaced_key', ['api_key']);
      const [row] = await tx
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, id))
        .limit(1);
      if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
      return toAdmin(row);
    });
  }

  /**
   * One row per successful mutation, in that mutation's own transaction. Field
   * names only — a value in this table would be a second copy of a secret with
   * none of the first one's protections (M7.8, FR-805).
   */
  private async audit(
    tx: Tx,
    connectionId: string,
    actorUserId: string,
    action: (typeof providerConnectionAudit.$inferInsert)['action'],
    changedFields: string[],
  ): Promise<void> {
    await tx
      .insert(providerConnectionAudit)
      .values({ connectionId, actorUserId, action, changedFields });
  }
}
