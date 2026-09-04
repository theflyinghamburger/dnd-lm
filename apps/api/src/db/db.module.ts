import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DB = Symbol('DB');
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * One pool, one database (D-1). Advisory locks in M5 need a real client handle,
 * which is why this exposes drizzle over postgres-js rather than a repository
 * abstraction that would have to grow an escape hatch for raw SQL.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Db => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is not set');
        return drizzle(postgres(url), { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
