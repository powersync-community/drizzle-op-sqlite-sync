import { Query } from 'drizzle-orm';
import { DefaultLogger } from 'drizzle-orm/logger';
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type RelationalSchemaConfig,
  type TablesRelationalConfig
} from 'drizzle-orm/relations';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import { OPSQLiteSession } from './OPSQLiteSession.js';
import { DB, QueryResult } from '@op-engineering/op-sqlite';

export type DrizzleQuery<T> = { toSQL(): Query; execute(): Promise<T | T[]> };

export class OPSQLiteDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>
> extends BaseSQLiteDatabase<'sync', QueryResult, TSchema> {}

export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: DB,
  config: DrizzleConfig<TSchema> = {}
): OPSQLiteDatabase<TSchema> & {
  $client: DB;
} {
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  let logger;
  if (config.logger === true) {
    logger = new DefaultLogger();
  } else if (config.logger !== false) {
    logger = config.logger;
  }

  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap
    };
  }

  const session = new OPSQLiteSession(client, dialect, schema, { logger });
  const db = new OPSQLiteDatabase('sync', dialect, session, schema) as OPSQLiteDatabase<TSchema>;
  (<any>db).$client = client;
  (<any>db).$cache = config.cache;
  if ((<any>db).$cache) {
    (<any>db).$cache['invalidate'] = config.cache?.onMutate;
  }

  return db as any;
}
