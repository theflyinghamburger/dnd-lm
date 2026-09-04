import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { PublicUser } from '@dnd-lm/contracts';
import type { AuthedRequest } from './auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PublicUser => {
    const request = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!request.user) throw new Error('CurrentUser used on a route without AuthGuard');
    return request.user;
  },
);
