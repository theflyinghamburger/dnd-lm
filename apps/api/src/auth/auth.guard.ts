import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PublicUser } from '@dnd-lm/contracts';
import type { Request } from 'express';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { IS_PUBLIC } from './public.decorator';

export type AuthedRequest = Request & { user?: PublicUser };

/** Registered as an APP_GUARD, so every route is authenticated unless `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });

    const user = await this.auth.resolveSession(token);
    if (!user) throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });

    request.user = user;
    return true;
  }
}
