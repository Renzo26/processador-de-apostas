import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migration20261105000001InitialSchema } from './migrations/Migration20261105000001InitialSchema';

export function buildOrmConfig(overrides: Partial<Options> = {}): Options {
  return defineConfig({
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:55432/wagering',
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 2, max: Number(process.env.DB_POOL_MAX ?? 20) },
    migrations: {
      tableName: 'mikro_orm_migrations',
      // Lista explícita: não depende de glob/descoberta em disco (funciona igual no Bun, em testes e em build).
      migrationsList: [{ name: 'Migration20261105000001InitialSchema', class: Migration20261105000001InitialSchema }],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: process.env.DB_DEBUG === 'true',
    ...overrides,
  });
}
