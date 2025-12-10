import React from 'react';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  AbstractPowerSyncDatabase,
  BaseObserver,
  BatchedUpdateNotification,
  createBaseLogger,
  DBAdapterListener,
  LogLevel,
  PowerSyncDatabase,
  RowUpdateType,
  UpdateNotification,
} from '@powersync/react-native';
import { relations } from 'drizzle-orm';
import { OPSqliteOpenFactory } from '@powersync/op-sqlite';
import {
  DrizzleAppSchema,
  PowerSyncSQLiteDatabase,
  wrapPowerSyncWithDrizzle,
} from '@powersync/drizzle-driver';
import {
  drizzle,
  OPSQLiteDatabase,
} from '@powersync-community/drizzle-op-sqlite-sync';
import { DB } from '@op-engineering/op-sqlite';

const logger = createBaseLogger();
logger.useDefaults();
logger.setLevel(LogLevel.DEBUG);

export class SelfhostConnector {
  private _clientId: string | null = null;

  async fetchCredentials() {
    const token = await fetch('http://localhost:6060/api/auth/token')
      .then(response => response.json())
      .then(data => data.token);

    return {
      endpoint: 'http://localhost:8080',
      token,
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();

    if (!transaction) {
      return;
    }

    if (!this._clientId) {
      this._clientId = await database.getClientId();
    }

    try {
      let batch: any[] = [];
      for (let operation of transaction.crud) {
        let payload = {
          op: operation.op,
          table: operation.table,
          id: operation.id,
          data: operation.opData,
        };
        batch.push(payload);
      }

      const response = await fetch(`http://localhost:6060/api/data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batch }),
      });

      if (!response.ok) {
        throw new Error(
          `Received ${
            response.status
          } from /api/data: ${await response.text()}`,
        );
      }

      await transaction.complete();
      console.log('Transaction completed successfully');
    } catch (ex: any) {
      console.debug(ex);
      throw ex;
    }
  }
}

export const drizzleLists = sqliteTable('lists', {
  id: text('id'),
  name: text('name'),
  owner_id: text('owner_id'),
});

export const drizzleTodos = sqliteTable('todos', {
  id: text('id'),
  description: text('description'),
  list_id: text('list_id'),
  created_at: text('created_at'),
});

export const listsRelations = relations(drizzleLists, ({ one, many }) => ({
  todos: many(drizzleTodos),
}));

export const todosRelations = relations(drizzleTodos, ({ one, many }) => ({
  list: one(drizzleLists, {
    fields: [drizzleTodos.list_id],
    references: [drizzleLists.id],
  }),
}));

const drizzleSchema = {
  lists: drizzleLists,
  todos: drizzleTodos,
  listsRelations,
  todosRelations,
};

const schema = new DrizzleAppSchema(drizzleSchema);

export const DB_NAME = 'powersync-op-sqlite.db';

export class System {
  connector: SelfhostConnector;
  powersync: PowerSyncDatabase;
  drizzle: PowerSyncSQLiteDatabase<typeof drizzleSchema>;
  drizzleSync?: OPSQLiteDatabase<typeof drizzleSchema>;
  updateBuffer: UpdateNotification[] = [];

  constructor() {
    this.connector = new SelfhostConnector();
    this.powersync = new PowerSyncDatabase({
      schema,
      database: new OPSqliteOpenFactory({
        dbFilename: DB_NAME,
      }),
      logger,
    });

    this.drizzle = wrapPowerSyncWithDrizzle(this.powersync, {
      schema: drizzleSchema,
    });
  }

  async init() {
    await this.powersync.init();
    await this.powersync.connect(this.connector);
    await this.powersync.waitForFirstSync();

    const adapter = this.powersync.database as any;
    const db = adapter.writeConnection.DB;

    this.drizzleSync = drizzle(db, {
      schema: drizzleSchema,
    });
    
    this.initPowersyncOpSqlite(db);
  }

  initPowersyncOpSqlite(db: DB) {
    // const opSqlite = open({
    //   name: DB_NAME,
    // });

    const baseStatements = [
      `PRAGMA journal_mode = WAL`,
      `PRAGMA busy_timeout = ${5000}`,
      `PRAGMA cache_size = -${50 * 1024}`,
    ];

    for (const stmt of baseStatements) {
      // Sync version of the execute function will block the JS thread and therefore your UI
      db.executeSync(stmt);
    }

    // Handle update hook to buffer row changes during a transaction
    db.updateHook(update => {
      let opType: RowUpdateType;
      switch (update.operation) {
        case 'INSERT':
          opType = RowUpdateType.SQLITE_INSERT;
          break;
        case 'DELETE':
          opType = RowUpdateType.SQLITE_DELETE;
          break;
        case 'UPDATE':
          opType = RowUpdateType.SQLITE_UPDATE;
          break;
      }

      console.log('Update Hook:', update.table, opType, update.rowId);

      this.updateBuffer.push({
        table: update.table,
        opType,
        rowId: update.rowId,
      });
    });

    // Handle commit hook to notify listeners after a successful transaction
    db.commitHook(() => {
      if (!this.updateBuffer.length) {
        return;
      }

      console.info(
        'Commit Hook: Notifying listeners of updates',
        this.updateBuffer,
      );

      const groupedUpdates = this.updateBuffer.reduce(
        (grouping: Record<string, UpdateNotification[]>, update) => {
          const { table } = update;
          const updateGroup = grouping[table] || (grouping[table] = []);
          updateGroup.push(update);
          return grouping;
        },
        {},
      );

      const batchedUpdate: BatchedUpdateNotification = {
        groupedUpdates,
        rawUpdates: this.updateBuffer,
        tables: Object.keys(groupedUpdates),
      };

      this.updateBuffer = [];

      const adapter = this.powersync
        .database as any as BaseObserver<DBAdapterListener>;

      adapter.iterateListeners(l => {
        return l.tablesUpdated?.(batchedUpdate);
      });
    });

    return db;
  }
}

const system = new System();
export const SystemContext = React.createContext(system);
export const useSystem = () => React.useContext(SystemContext);
