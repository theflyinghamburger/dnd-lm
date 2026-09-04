import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * Opt a route out of the global `AuthGuard`. Authentication is on by default
 * (M1.1) so forgetting a decorator locks a route down rather than opening it.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
