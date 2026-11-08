import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/infrastructure/database/mikro-orm.config';

/** Uso: bun scripts/migrate.ts [up|down|status] */
const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(buildOrmConfig());

try {
  const migrator = orm.migrator;
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(`migrations applied: ${applied.map((m) => m.name).join(', ') || '(none)'}`);
  } else if (command === 'down') {
    const reverted = await migrator.down();
    console.log(`migrations reverted: ${reverted.map((m) => m.name).join(', ') || '(none)'}`);
  } else if (command === 'status') {
    console.log('executed:', (await migrator.getExecuted()).map((m) => m.name));
    console.log('pending :', (await migrator.getPending()).map((m) => m.name));
  } else {
    throw new Error(`unknown command "${command}"`);
  }
} finally {
  await orm.close();
}
