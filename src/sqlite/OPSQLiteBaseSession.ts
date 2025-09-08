import { entityKind } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { NoopLogger } from 'drizzle-orm/logger';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import { type Query } from 'drizzle-orm/sql/sql';
import type { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import type { SelectedFieldsOrdered } from 'drizzle-orm/sqlite-core/query-builders/select.types';
import {
  type PreparedQueryConfig as PreparedQueryConfigBase,
  type SQLiteExecuteMethod,
  SQLiteSession,
  SQLiteTransaction,
  type SQLiteTransactionConfig
} from 'drizzle-orm/sqlite-core/session';
import { DB, QueryResult } from '@op-engineering/op-sqlite';
import { OPSQLitePreparedQuery } from './OPSQLitePreparedQuery.js';
export interface OpSQLiteSessionOptions {
  logger?: Logger;
}

export type OPSQLiteTransactionConfig = SQLiteTransactionConfig & {
  accessMode?: 'read only' | 'read write';
};

export class OPSQLiteTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig
> extends SQLiteTransaction<'sync', QueryResult, TFullSchema, TSchema> {
  static readonly [entityKind]: string = 'OPSQLiteTransaction';
}

export class OPSQLiteBaseSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig
> extends SQLiteSession<'sync', QueryResult, TFullSchema, TSchema> {
  static readonly [entityKind]: string = 'OPSQLiteBaseSession';

  protected logger: Logger;

  constructor(
    protected db: DB,
    protected dialect: SQLiteSyncDialect,
    protected schema: RelationalSchemaConfig<TSchema> | undefined,
    protected options: OpSQLiteSessionOptions = {}
  ) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
  }

  prepareQuery<T extends PreparedQueryConfigBase & { type: 'sync' }>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown
  ): OPSQLitePreparedQuery<T> {
    return new OPSQLitePreparedQuery(
      this.db,
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper
    );
  }

  transaction<T>(
    _transaction: (tx: OPSQLiteTransaction<TFullSchema, TSchema>) => T,
    _config: OPSQLiteTransactionConfig = {}
  ): T {
    throw new Error('Nested transactions are not supported');
  }
}
