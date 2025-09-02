import { entityKind } from 'drizzle-orm/entity';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import type { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import {
  OPSQLiteBaseSession,
  OpSQLiteSessionOptions,
  OPSQLiteTransaction,
  OPSQLiteTransactionConfig
} from './OPSQLiteBaseSession.js';
import { DB } from '@op-engineering/op-sqlite';
import { sql } from 'drizzle-orm';

export class OPSQLiteSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig
> extends OPSQLiteBaseSession<TFullSchema, TSchema> {
  static readonly [entityKind]: string = 'OPSQLiteSession';
  protected client: DB;
  constructor(
    db: DB,
    dialect: SQLiteSyncDialect,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: OpSQLiteSessionOptions = {}
  ) {
    super(db, dialect, schema, options);
    this.client = db;
  }

  transaction<T>(
    transaction: (tx: OPSQLiteTransaction<TFullSchema, TSchema>) => T,
    config: OPSQLiteTransactionConfig = {}
  ): T {
    let result: T;

    const tx = new OPSQLiteTransaction<TFullSchema, TSchema>(
      'sync',
      this.dialect,
      new OPSQLiteBaseSession(this.client, this.dialect, this.schema, this.options),
      this.schema
    );

    this.run(sql`begin${config?.behavior ? ' ' + config.behavior : ''}`);
    try {
      result = transaction(tx);
      this.run(sql`commit`);
    } catch (err) {
      this.run(sql`rollback`);
      throw err;
    }

    return result;
  }
}
