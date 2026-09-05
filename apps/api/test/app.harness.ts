import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';

export const DATABASE_URL = process.env.DATABASE_URL;

// M7.2: the master key is a deployment requirement, not an app default. Tests
// provision their own the same way CI provisions DATABASE_URL.
process.env.PROVIDER_KEY_ENCRYPTION_KEY ??= '0'.repeat(64);

// Skipping the integration suite is a local-machine convenience. In CI it would
// mean the authorization guarantees silently stopped being tested.
if (!DATABASE_URL && process.env.CI) {
  throw new Error('DATABASE_URL must be set in CI — the integration tests need a database');
}

export type TestApp = { app: INestApplication; db: Db; port: number };

/**
 * Listens on an ephemeral port: socket.io only attaches to a real HTTP server,
 * so the WebSocket tests cannot run against `app.init()` alone.
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  await app.listen(0);

  const address = app.getHttpServer().address();
  if (typeof address !== 'object' || address === null) throw new Error('no ephemeral port');
  return { app, db: app.get<Db>(DB), port: address.port };
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE messages, commands, session_events, sessions, invites, memberships, campaigns, auth_sessions, provider_connection_audit, provider_connections, users RESTART IDENTITY CASCADE`,
  );
}
