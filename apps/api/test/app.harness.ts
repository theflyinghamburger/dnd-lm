import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';

export const DATABASE_URL = process.env.DATABASE_URL;

// Skipping the integration suite is a local-machine convenience. In CI it would
// mean the authorization guarantees silently stopped being tested.
if (!DATABASE_URL && process.env.CI) {
  throw new Error('DATABASE_URL must be set in CI — the M1 authorization tests need a database');
}

export async function createTestApp(): Promise<{ app: INestApplication; db: Db }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  await app.init();
  return { app, db: app.get<Db>(DB) };
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE invites, memberships, campaigns, auth_sessions, users RESTART IDENTITY CASCADE`,
  );
}
