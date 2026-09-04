import { Inject, Injectable } from '@nestjs/common';
import type { MembershipRole } from '@dnd-lm/contracts';
import { and, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { memberships } from '../db/schema';

/**
 * The one place membership is resolved, so the HTTP guard and the WebSocket
 * handshake cannot drift apart on what counts as a member (M1.3, M2.2).
 */
@Injectable()
export class MembershipService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async roleFor(campaignId: string, userId: string): Promise<MembershipRole | null> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId)))
      .limit(1);
    return row?.role ?? null;
  }

  /**
   * The platform-admin definition (M7.4, option (a)): an `admin` membership
   * in **any** campaign. No user-level flag, no new column — the one-DB MVP
   * gets the role from the table it already has.
   */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ admin: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.role, 'admin')))
      .limit(1);
    return row !== undefined;
  }
}
