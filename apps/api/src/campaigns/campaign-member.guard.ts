import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@dnd-lm/contracts';
import { and, eq } from 'drizzle-orm';
import type { AuthedRequest } from '../auth/auth.guard';
import { DB, type Db } from '../db/db.module';
import { memberships } from '../db/schema';

export const CAMPAIGN_ROLES = 'campaign:roles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrow a campaign route to specific roles. Absent means "any member". */
export const CampaignRoles = (...roles: MembershipRole[]) => SetMetadata(CAMPAIGN_ROLES, roles);

export type MemberRequest = AuthedRequest & { membershipRole?: MembershipRole };

/**
 * Membership is re-read from the database on **every** request (M1.3, FR-105).
 * It is never cached in the session cookie: revoking a member has to take
 * effect on their next request, not on their next login.
 */
@Injectable()
export class CampaignMemberGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MemberRequest>();
    const user = request.user;
    if (!user) throw new ForbiddenException({ code: 'NOT_A_MEMBER' });

    // Express can hand back an array for a repeated param; only a single value
    // identifies a campaign, and anything else is a malformed request.
    const raw: unknown = request.params?.['campaignId'];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new BadRequestException({ code: 'CAMPAIGN_ID_MISSING' });
    }
    // A non-uuid would reach Postgres as a cast error and surface as a 500.
    // Same 403 as a real non-member, so the shape of an id is not a probe either.
    if (!UUID.test(raw)) throw new ForbiddenException({ code: 'NOT_A_MEMBER' });
    const campaignId = raw;

    const [membership] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, user.id)))
      .limit(1);

    // A non-member gets the same 403 as a member lacking the role, so campaign
    // existence is not probeable.
    if (!membership) throw new ForbiddenException({ code: 'NOT_A_MEMBER' });

    const required = this.reflector.getAllAndOverride<MembershipRole[]>(CAMPAIGN_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.includes(membership.role)) {
      throw new ForbiddenException({ code: 'NOT_A_MEMBER' });
    }

    request.membershipRole = membership.role;
    return true;
  }
}
