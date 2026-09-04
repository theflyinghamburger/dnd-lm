import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { LoginRequest, PublicUser, RegisterRequest } from '@dnd-lm/contracts';
import { and, eq, gt } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { authSessions, users } from '../db/schema';
import { hashPassword, verifyPassword } from './password';

export const SESSION_COOKIE = 'dnd_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The cookie carries the token; the database stores only its digest. */
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async register(input: RegisterRequest): Promise<PublicUser> {
    const passwordHash = await hashPassword(input.password);
    const [user] = await this.db
      .insert(users)
      .values({ email: input.email, displayName: input.displayName, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email, displayName: users.displayName });

    if (!user) throw new ConflictException({ code: 'EMAIL_TAKEN' });
    return user;
  }

  async login(input: LoginRequest): Promise<PublicUser> {
    const [user] = await this.db.select().from(users).where(eq(users.email, input.email)).limit(1);

    // Hash even when the account is missing, so a timing difference does not
    // enumerate registered addresses.
    const ok = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aaaa', input.password);

    if (!user || !ok) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  /** Returns the raw token — the only moment it exists outside the client's cookie jar. */
  async issueSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.insert(authSessions).values({ tokenHash: digest(token), userId, expiresAt });
    return { token, expiresAt };
  }

  async resolveSession(token: string): Promise<PublicUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.tokenHash, digest(token)), gt(authSessions.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.tokenHash, digest(token)));
  }
}
