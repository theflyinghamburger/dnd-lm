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
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaigns, providerConnections } from '../db/schema';
import { BaseUrlService } from './base-url.service';
import { ProviderSecrets } from './provider-secrets.service';

type Row = typeof providerConnections.$inferSelect;

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
      throw new BadRequestException({ code: 'BASE_URL_REJECTED', reason: verdict.reason });
    }
    const key = input.apiKey ? this.secrets.encrypt(input.apiKey) : null;
    const [row] = await this.db
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
    return toAdmin(row);
  }

  async update(id: string, input: UpdateConnectionRequest): Promise<AdminConnection> {
    if (input.baseUrl !== undefined) {
      const verdict = await this.urls.validate(input.baseUrl);
      if (!verdict.ok) {
        throw new BadRequestException({ code: 'BASE_URL_REJECTED', reason: verdict.reason });
      }
    }
    const set: Partial<Row> = { updatedAt: new Date() };
    if (input.label !== undefined) set.label = input.label;
    if (input.baseUrl !== undefined) set.baseUrl = input.baseUrl;
    if (input.modelId !== undefined) set.modelId = input.modelId;
    if (input.maxTokens !== undefined) set.maxTokens = input.maxTokens;
    if (input.enabled !== undefined) set.enabled = input.enabled;

    const [row] = await this.db
      .update(providerConnections)
      .set(set)
      .where(eq(providerConnections.id, id))
      .returning();
    if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
    return toAdmin(row);
  }

  /**
   * Refused — with the campaign names named — while any campaign still points
   * at this connection (the MVP.md default, chosen over silently clearing the
   * reference: an admin delete should not quietly rewire a campaign's DM).
   */
  async delete(id: string): Promise<void> {
    const inUseBy = await this.db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(sql`${campaigns.settings}->>'provider_connection_id' = ${id}`);
    if (inUseBy.length > 0) {
      throw new ConflictException({
        code: 'CONNECTION_IN_USE',
        campaigns: inUseBy.map((c) => ({ id: c.id, name: c.name })),
      });
    }
    const [row] = await this.db
      .delete(providerConnections)
      .where(eq(providerConnections.id, id))
      .returning();
    if (!row) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
  }

  /** M7.2's re-encrypt under a fresh nonce; the row must exist first. */
  async replaceKey(id: string, apiKey: string): Promise<AdminConnection> {
    await this.getForAdmin(id);
    await this.secrets.replaceKey(id, apiKey);
    return this.getForAdmin(id);
  }
}
