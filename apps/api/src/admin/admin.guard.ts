import { type CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';
import { MembershipService } from '../campaigns/membership.service';

/**
 * Platform-admin only (M7.4). A base URL is an SSRF vector and an API key a
 * spend-and-exfiltration vector; neither blast radius extends past this guard
 * (NFR-301). Definition, per the in-thread decision, is the one with no new
 * column: an `admin` membership in any campaign (option (a)).
 *
 * The role is re-read from the database on every request, the same way
 * `CampaignMemberGuard` does, so revoking it takes effect on the next request.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly memberships: MembershipService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const user = request.user;
    if (!user) throw new ForbiddenException({ code: 'NOT_PLATFORM_ADMIN' });
    if (!(await this.memberships.isPlatformAdmin(user.id))) {
      throw new ForbiddenException({ code: 'NOT_PLATFORM_ADMIN' });
    }
    return true;
  }
}
