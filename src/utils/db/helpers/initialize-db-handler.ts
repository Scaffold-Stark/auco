import { BaseDbHandler } from '../base-db-handler';
import {
  DbHandlerType,
  MysqlDbHandlerConfig,
  PostgresDbHandlerConfig,
  SqliteDbHandlerConfig,
} from '../../../types/db-handler';
import { PostgresDbHandler } from '../postgres-db-handler';
import { MysqlDbHandler } from '../mysql-db-handler';
import { SqliteDbHandler } from '../sqlite-db-handler';
// Implementation
export function initializeDbHandler(
  dbHandlerType: DbHandlerType,
  config: PostgresDbHandlerConfig | MysqlDbHandlerConfig | SqliteDbHandlerConfig
): BaseDbHandler {
  if (!config) {
    throw new Error('Config is required');
  }

  switch (dbHandlerType) {
    case 'postgres':
      if (!('connectionString' in config)) {
        throw new Error('Invalid config type for postgres database');
      }
      return new PostgresDbHandler(config as PostgresDbHandlerConfig);
    case 'mysql':
      if (!('connectionString' in config)) {
        throw new Error('Invalid config type for mysql database');
      }
      return new MysqlDbHandler(config as MysqlDbHandlerConfig);
    case 'sqlite':
      if (!('dbPath' in config)) {
        throw new Error('Invalid config type for sqlite database');
      }
      return new SqliteDbHandler(config as SqliteDbHandlerConfig);
  }
}
