/**
 * Screen for running the simultaneous writes integration test.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Button,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import {
  PowerSyncDatabase,
  createBaseLogger,
  LogLevel,
} from '@powersync/react-native';
import { DrizzleAppSchema } from '@powersync/drizzle-driver';
import { OPSqliteOpenFactory } from '@powersync/op-sqlite';
import {
  drizzle,
  OPSQLiteDatabase,
} from '@powersync-community/drizzle-op-sqlite-sync';
import { DB, open } from '@op-engineering/op-sqlite';

// Simple UUID generator for testing
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

// Define test schema - using lists table
const listsTable = sqliteTable('lists', {
  id: text('id').primaryKey(),
  name: text('name'),
  owner_id: text('owner_id'),
});

const drizzleSchema = {
  lists: listsTable,
};

const schema = new DrizzleAppSchema(drizzleSchema);

const DB_NAME = 'test-simultaneous-writes.db';
const POWER_SYNC_WRITE_COUNT = 100;
const MIXED_OP_COUNT = 50;

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function getPowerSyncWriteDB(powersync: PowerSyncDatabase): DB {
  const adapter = powersync.database as any;
  if (!adapter?.writeConnection?.DB) {
    throw new Error('PowerSync write connection not available');
  }
  return adapter.writeConnection.DB as DB;
}

async function runLockingTest(
  powersync: PowerSyncDatabase,
  separateWriteConnection: DB,
): Promise<TestResult> {
  const lockTestId = uuid();
  let lockError: string | undefined;

  try {
    separateWriteConnection.executeSync('BEGIN IMMEDIATE TRANSACTION');
    await powersync.execute(
      'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
      [lockTestId, 'Locked insert', uuid()],
    );
  } catch (err) {
    lockError = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      separateWriteConnection.executeSync('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
  }

  const lockDetected = !!lockError && lockError.toLowerCase().includes('lock');
  console.log('[TEST] Locking test result:', {
    lockDetected,
    lockError,
  });

  return {
    name: 'Separate write connection blocks PowerSync write',
    passed: lockDetected,
    error: lockDetected
      ? undefined
      : `Expected lock error when separate connection holds transaction. Got: ${
          lockError ?? 'no error'
        }`,
  };
}

async function runHookedConnectionSimultaneousWrites(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  const drizzleId = uuid();
  const powersyncIds = Array.from({ length: POWER_SYNC_WRITE_COUNT }, () =>
    uuid(),
  );

  console.log('[TEST] Starting hooked-connection concurrent writes...');

  const powersyncWrites = powersyncIds.map((id, index) =>
    powersync.execute(
      'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
      [id, `PowerSync List ${index + 1}`, uuid()],
    ),
  );

  const drizzleWrite = drizzleOnPowerSync.insert(listsTable).values({
    id: drizzleId,
    name: 'Drizzle List (hooked)',
    owner_id: uuid(),
  });

  await Promise.all([...powersyncWrites, drizzleWrite]);

  const queryResults = await powersync.getAll(
    'SELECT * FROM lists ORDER BY name',
  );

  const expectedCount = powersyncIds.length + 1;
  const hasDrizzleItem = queryResults.some(
    (r: any) => r.id === drizzleId && r.name === 'Drizzle List (hooked)',
  );
  const powersyncItemsCount = queryResults.filter((r: any) =>
    powersyncIds.includes(r.id),
  ).length;

  const passed =
    queryResults.length === expectedCount &&
    hasDrizzleItem &&
    powersyncItemsCount === powersyncIds.length;

  return {
    name: 'Hooked connection concurrent writes succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${expectedCount} items (PowerSync + Drizzle on same connection), got ${queryResults.length}. PowerSync items: ${powersyncItemsCount}, Drizzle item found: ${hasDrizzleItem}`,
  };
}

async function runConcurrentUpdates(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  // First insert test records
  const updateIds = Array.from({ length: MIXED_OP_COUNT }, () => uuid());
  await Promise.all(
    updateIds.map((id, index) =>
      powersync.execute(
        'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
        [id, `Original Name ${index}`, uuid()],
      ),
    ),
  );

  console.log('[TEST] Starting concurrent updates...');

  // Update half with PowerSync, half with Drizzle
  const powersyncUpdates = updateIds
    .slice(0, MIXED_OP_COUNT / 2)
    .map((id, index) =>
      powersync.execute('UPDATE lists SET name = ? WHERE id = ?', [
        `PowerSync Updated ${index}`,
        id,
      ]),
    );

  const drizzleUpdates = updateIds.slice(MIXED_OP_COUNT / 2).map((id, index) =>
    drizzleOnPowerSync
      .update(listsTable)
      .set({ name: `Drizzle Updated ${index}` })
      .where(eq(listsTable.id, id)),
  );

  await Promise.all([...powersyncUpdates, ...drizzleUpdates]);

  const queryResults = await powersync.getAll('SELECT * FROM lists');

  // Verify all records were updated
  const powersyncUpdatedCount = queryResults.filter((r: any) =>
    r.name?.startsWith('PowerSync Updated'),
  ).length;
  const drizzleUpdatedCount = queryResults.filter((r: any) =>
    r.name?.startsWith('Drizzle Updated'),
  ).length;
  const originalCount = queryResults.filter((r: any) =>
    r.name?.startsWith('Original Name'),
  ).length;

  const passed =
    queryResults.length === MIXED_OP_COUNT &&
    powersyncUpdatedCount === MIXED_OP_COUNT / 2 &&
    drizzleUpdatedCount === MIXED_OP_COUNT / 2 &&
    originalCount === 0;

  return {
    name: 'Concurrent updates (PowerSync + Drizzle) succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${MIXED_OP_COUNT} total (${MIXED_OP_COUNT / 2} each), got ${
          queryResults.length
        } total. PowerSync: ${powersyncUpdatedCount}, Drizzle: ${drizzleUpdatedCount}, Unchanged: ${originalCount}`,
  };
}

async function runConcurrentDeletes(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  // Insert test records
  const deleteIds = Array.from({ length: MIXED_OP_COUNT }, () => uuid());
  await Promise.all(
    deleteIds.map((id, index) =>
      powersync.execute(
        'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
        [id, `To Delete ${index}`, uuid()],
      ),
    ),
  );

  console.log('[TEST] Starting concurrent deletes...');

  // Delete half with PowerSync, half with Drizzle
  const powersyncDeletes = deleteIds
    .slice(0, MIXED_OP_COUNT / 2)
    .map(id => powersync.execute('DELETE FROM lists WHERE id = ?', [id]));

  const drizzleDeletes = deleteIds
    .slice(MIXED_OP_COUNT / 2)
    .map(id =>
      drizzleOnPowerSync.delete(listsTable).where(eq(listsTable.id, id)),
    );

  await Promise.all([...powersyncDeletes, ...drizzleDeletes]);

  const queryResults = await powersync.getAll('SELECT * FROM lists');

  const passed = queryResults.length === 0;

  return {
    name: 'Concurrent deletes (PowerSync + Drizzle) succeed',
    passed,
    error: passed
      ? undefined
      : `Expected 0 items after deleting all ${MIXED_OP_COUNT} records, got ${queryResults.length}`,
  };
}

async function runMixedOperations(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  // Setup: Create initial records to update/delete
  const updateIds = Array.from({ length: 10 }, () => uuid());
  const deleteIds = Array.from({ length: 10 }, () => uuid());

  await Promise.all([
    ...updateIds.map((id, i) =>
      powersync.execute(
        'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
        [id, `Will Update ${i}`, uuid()],
      ),
    ),
    ...deleteIds.map((id, i) =>
      powersync.execute(
        'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
        [id, `Will Delete ${i}`, uuid()],
      ),
    ),
  ]);

  console.log('[TEST] Starting mixed operations (insert/update/delete)...');

  // Generate IDs for new inserts
  const insertIdsPowerSync = Array.from({ length: 10 }, () => uuid());
  const insertIdsDrizzle = Array.from({ length: 10 }, () => uuid());

  // Mix all operations together
  const operations = [
    // PowerSync inserts
    ...insertIdsPowerSync.map((id, i) =>
      powersync.execute(
        'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
        [id, `PS Insert ${i}`, uuid()],
      ),
    ),
    // Drizzle inserts
    ...insertIdsDrizzle.map((id, i) =>
      drizzleOnPowerSync.insert(listsTable).values({
        id,
        name: `Drizzle Insert ${i}`,
        owner_id: uuid(),
      }),
    ),
    // PowerSync updates
    ...updateIds
      .slice(0, 5)
      .map((id, i) =>
        powersync.execute('UPDATE lists SET name = ? WHERE id = ?', [
          `PS Updated ${i}`,
          id,
        ]),
      ),
    // Drizzle updates
    ...updateIds.slice(5).map((id, i) =>
      drizzleOnPowerSync
        .update(listsTable)
        .set({ name: `Drizzle Updated ${i}` })
        .where(eq(listsTable.id, id)),
    ),
    // PowerSync deletes
    ...deleteIds
      .slice(0, 5)
      .map(id => powersync.execute('DELETE FROM lists WHERE id = ?', [id])),
    // Drizzle deletes
    ...deleteIds
      .slice(5)
      .map(id =>
        drizzleOnPowerSync.delete(listsTable).where(eq(listsTable.id, id)),
      ),
  ];

  await Promise.all(operations);

  const queryResults = await powersync.getAll('SELECT * FROM lists');

  // Expected: 10 updated + 20 inserted = 30 total
  const expectedCount = 30;
  const insertCount = queryResults.filter((r: any) =>
    r.name?.includes('Insert'),
  ).length;
  const updateCount = queryResults.filter((r: any) =>
    r.name?.includes('Updated'),
  ).length;
  const deleteCount = queryResults.filter((r: any) =>
    r.name?.includes('Delete'),
  ).length;

  const passed =
    queryResults.length === expectedCount &&
    insertCount === 20 &&
    updateCount === 10 &&
    deleteCount === 0;

  return {
    name: 'Mixed operations (insert/update/delete) succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${expectedCount} items (20 inserts, 10 updated, 0 deleted), got ${queryResults.length}. Inserts: ${insertCount}, Updates: ${updateCount}, Deletes still present: ${deleteCount}`,
  };
}

async function runSelectDuringWrites(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting reads during concurrent writes...');

  const insertIds = Array.from({ length: 50 }, () => uuid());

  // Start inserts
  const inserts = insertIds.map((id, i) =>
    powersync.execute(
      'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
      [id, `Item ${i}`, uuid()],
    ),
  );

  // Perform reads while writes are happening
  const reads = Array.from({ length: 10 }, () =>
    powersync.getAll('SELECT COUNT(*) as count FROM lists'),
  );

  const drizzleReads = Array.from({ length: 10 }, () =>
    drizzleOnPowerSync.select().from(listsTable),
  );

  // Wait for all operations
  await Promise.all([...inserts, ...reads, ...drizzleReads]);

  const finalResults = await powersync.getAll('SELECT * FROM lists');

  const passed = finalResults.length === insertIds.length;

  return {
    name: 'Reads during concurrent writes succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${insertIds.length} items after concurrent reads/writes, got ${finalResults.length}`,
  };
}

async function runWeavedInsertsAndUpdates(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting weaved inserts and updates...');

  const ids = Array.from({ length: 30 }, () => uuid());

  // First, insert all records concurrently
  const insertOperations = ids.map((id, i) => {
    const isEven = i % 2 === 0;
    return isEven
      ? powersync.execute(
          'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
          [id, `Initial ${i}`, uuid()],
        )
      : drizzleOnPowerSync.insert(listsTable).values({
          id,
          name: `Initial ${i}`,
          owner_id: uuid(),
        });
  });

  await Promise.all(insertOperations);

  // Then, update all records concurrently
  const updateOperations = ids.map((id, i) => {
    const isEven = i % 2 === 0;
    return isEven
      ? drizzleOnPowerSync
          .update(listsTable)
          .set({ name: `Updated ${i}` })
          .where(eq(listsTable.id, id))
      : powersync.execute('UPDATE lists SET name = ? WHERE id = ?', [
          `Updated ${i}`,
          id,
        ]);
  });

  await Promise.all(updateOperations);

  const queryResults = await powersync.getAll('SELECT * FROM lists');

  // All records should have "Updated" names
  const updatedCount = queryResults.filter((r: any) =>
    r.name?.startsWith('Updated'),
  ).length;

  const passed =
    queryResults.length === ids.length && updatedCount === ids.length;

  return {
    name: 'Weaved inserts and updates succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${ids.length} updated items, got ${queryResults.length} total with ${updatedCount} updated`,
  };
}

async function runTransactionsMixedAPIs(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting mixed API transactions...');

  const txnId1 = uuid();
  const txnId2 = uuid();
  const txnId3 = uuid();

  // Transaction 1: PowerSync raw SQL operations
  const txn1 = (async () => {
    await powersync.execute('INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)', [
      txnId1,
      'PowerSync Transaction',
      uuid(),
    ]);
    await powersync.execute('UPDATE lists SET name = ? WHERE id = ?', [
      'PowerSync Transaction Updated',
      txnId1,
    ]);
  })();

  // Transaction 2: Drizzle operations (weaved with PowerSync)
  const txn2 = (async () => {
    await drizzleOnPowerSync.insert(listsTable).values({
      id: txnId2,
      name: 'Drizzle Transaction',
      owner_id: uuid(),
    });
    await drizzleOnPowerSync
      .update(listsTable)
      .set({ name: 'Drizzle Transaction Updated' })
      .where(eq(listsTable.id, txnId2));
  })();

  // Transaction 3: Direct insert outside transactions for interleaving
  const txn3 = powersync.execute(
    'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
    [txnId3, 'Interleaved Insert', uuid()],
  );

  try {
    await Promise.all([txn1, txn2, txn3]);
  } catch (err) {
    console.log('[TEST] Transaction error:', err);
    return {
      name: 'Mixed API transactions succeed',
      passed: false,
      error: `Transaction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const queryResults = await powersync.getAll('SELECT * FROM lists ORDER BY id');
  const hasTxn1 = queryResults.some(
    (r: any) => r.id === txnId1 && r.name === 'PowerSync Transaction Updated',
  );
  const hasTxn2 = queryResults.some(
    (r: any) => r.id === txnId2 && r.name === 'Drizzle Transaction Updated',
  );
  const hasTxn3 = queryResults.some(
    (r: any) => r.id === txnId3 && r.name === 'Interleaved Insert',
  );

  const passed = hasTxn1 && hasTxn2 && hasTxn3;

  return {
    name: 'Mixed API transactions succeed',
    passed,
    error: passed
      ? undefined
      : `Expected all 3 transactions to complete. PowerSync: ${hasTxn1}, Drizzle: ${hasTxn2}, Interleaved: ${hasTxn3}`,
  };
}

async function runConcurrentSameRowUpdates(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting concurrent same-row updates...');

  const sharedId = uuid();
  const ownerId = uuid();

  // Insert a single shared record
  await powersync.execute(
    'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
    [sharedId, 'Shared Record', ownerId],
  );

  // Concurrently update the same row from both APIs
  const updateCount = 20;
  const updates = [];

  for (let i = 0; i < updateCount; i++) {
    if (i % 2 === 0) {
      // PowerSync update
      updates.push(
        powersync.execute('UPDATE lists SET name = ? WHERE id = ?', [
          `Updated by PowerSync ${i}`,
          sharedId,
        ]),
      );
    } else {
      // Drizzle update
      updates.push(
        drizzleOnPowerSync
          .update(listsTable)
          .set({ name: `Updated by Drizzle ${i}` })
          .where(eq(listsTable.id, sharedId)),
      );
    }
  }

  await Promise.all(updates);

  const queryResults = await powersync.getAll(
    'SELECT * FROM lists WHERE id = ?',
    [sharedId],
  );

  const passed = queryResults.length === 1 && (queryResults[0] as any).id === sharedId;

  return {
    name: 'Concurrent same-row updates succeed',
    passed,
    error: passed
      ? undefined
      : `Expected 1 row after ${updateCount} concurrent updates to same row, got ${queryResults.length}`,
  };
}

async function runLargeBatchOperations(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting large batch operations...');

  const LARGE_BATCH_SIZE = 500;
  const insertIds = Array.from({ length: LARGE_BATCH_SIZE }, () => uuid());

  // Split IDs between PowerSync and Drizzle
  const psIds = insertIds.slice(0, LARGE_BATCH_SIZE / 2);
  const drizzleIds = insertIds.slice(LARGE_BATCH_SIZE / 2);

  const psInserts = psIds.map((id, i) =>
    powersync.execute(
      'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
      [id, `PS Batch ${i}`, uuid()],
    ),
  );

  const drizzleInserts = drizzleIds.map((id, i) =>
    drizzleOnPowerSync.insert(listsTable).values({
      id,
      name: `Drizzle Batch ${i}`,
      owner_id: uuid(),
    }),
  );

  await Promise.all([...psInserts, ...drizzleInserts]);

  const queryResults = await powersync.getAll('SELECT * FROM lists');

  const passed = queryResults.length === LARGE_BATCH_SIZE;

  return {
    name: 'Large batch operations (500) succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${LARGE_BATCH_SIZE} items from large batch, got ${queryResults.length}`,
  };
}

async function runDeleteAndInsertSameId(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting delete+insert same ID operations...');

  const testId = uuid();
  const ownerId = uuid();

  // Initial insert
  await powersync.execute(
    'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
    [testId, 'Initial', ownerId],
  );

  // Sequential delete and insert cycles (simulating sync tombstone scenario)
  // Run sequentially to avoid UNIQUE constraint violations from concurrent inserts
  for (let i = 0; i < 10; i++) {
    const isDelete = i % 2 === 0;
    if (isDelete) {
      await powersync.execute('DELETE FROM lists WHERE id = ?', [testId]);
    } else {
      await drizzleOnPowerSync.insert(listsTable).values({
        id: testId,
        name: `Reinserted ${i}`,
        owner_id: ownerId,
      });
    }
  }

  const queryResults = await powersync.getAll(
    'SELECT * FROM lists WHERE id = ?',
    [testId],
  );

  // Final state should be either inserted (last op was insert) or deleted (last op was delete)
  const finalState = queryResults.length;
  const passed = finalState <= 1; // Should have 0 or 1 row, not duplicates

  return {
    name: 'Delete+insert same ID (tombstone scenario) succeeds',
    passed,
    error: passed
      ? undefined
      : `Expected 0 or 1 row after delete+insert cycles, got ${finalState}`,
  };
}

async function runRapidSequentialWrites(
  powersync: PowerSyncDatabase,
  drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema>,
): Promise<TestResult> {
  await powersync.execute('DELETE FROM lists');

  console.log('[TEST] Starting rapid sequential writes...');

  const BURST_SIZE = 5;
  const NUM_BURSTS = 10;
  let totalInserted = 0;

  for (let burst = 0; burst < NUM_BURSTS; burst++) {
    const burstIds = Array.from({ length: BURST_SIZE }, () => uuid());

    // Alternate which API writes in each burst
    const writeOps = burstIds.map((id, i) => {
      const usePS = burst % 2 === 0;
      if (usePS) {
        return powersync.execute(
          'INSERT INTO lists (id, name, owner_id) VALUES (?, ?, ?)',
          [id, `Burst ${burst} PS ${i}`, uuid()],
        );
      } else {
        return drizzleOnPowerSync.insert(listsTable).values({
          id,
          name: `Burst ${burst} Drizzle ${i}`,
          owner_id: uuid(),
        });
      }
    });

    await Promise.all(writeOps);
    totalInserted += BURST_SIZE;

    // Small delay between bursts to simulate real usage
    await new Promise<void>(resolve => setTimeout(() => resolve(), 10));
  }

  const queryResults = await powersync.getAll('SELECT * FROM lists');
  const expectedTotal = BURST_SIZE * NUM_BURSTS;
  const passed = queryResults.length === expectedTotal;

  return {
    name: 'Rapid sequential writes (bursts) succeed',
    passed,
    error: passed
      ? undefined
      : `Expected ${expectedTotal} items after ${NUM_BURSTS} bursts of ${BURST_SIZE}, got ${queryResults.length}`,
  };
}

export async function runSimultaneousWritesTest(
  onResult: (result: TestResult) => void,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  let powersync: PowerSyncDatabase | null = null;
  let separateWriteConnection: DB | null = null;
  let drizzleOnPowerSync: OPSQLiteDatabase<typeof drizzleSchema> | null = null;

  const addResult = (result: TestResult) => {
    results.push(result);
    onResult(result);
  };

  try {
    const logger = createBaseLogger();
    logger.useDefaults();
    logger.setLevel(LogLevel.DEBUG);

    // Initialize PowerSync
    powersync = new PowerSyncDatabase({
      schema,
      database: new OPSqliteOpenFactory({
        dbFilename: DB_NAME,
      }),
      logger,
    });

    await powersync.init();

    separateWriteConnection = open({
      name: DB_NAME,
    });

    // Create single shared drizzle instance
    const db = getPowerSyncWriteDB(powersync);
    drizzleOnPowerSync = drizzle(db, { schema: drizzleSchema });

    // Run all tests in sequence
    addResult(await runHookedConnectionSimultaneousWrites(powersync, drizzleOnPowerSync));
    addResult(await runConcurrentUpdates(powersync, drizzleOnPowerSync));
    addResult(await runConcurrentDeletes(powersync, drizzleOnPowerSync));
    addResult(await runMixedOperations(powersync, drizzleOnPowerSync));
    addResult(await runSelectDuringWrites(powersync, drizzleOnPowerSync));
    addResult(await runWeavedInsertsAndUpdates(powersync, drizzleOnPowerSync));
    addResult(await runTransactionsMixedAPIs(powersync, drizzleOnPowerSync));
    addResult(await runConcurrentSameRowUpdates(powersync, drizzleOnPowerSync));
    addResult(await runLargeBatchOperations(powersync, drizzleOnPowerSync));
    addResult(await runDeleteAndInsertSameId(powersync, drizzleOnPowerSync));
    addResult(await runRapidSequentialWrites(powersync, drizzleOnPowerSync));
    addResult(await runLockingTest(powersync, separateWriteConnection));
  } catch (error) {
    const errorResult = {
      name: 'Simultaneous writes test harness',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
    addResult(errorResult);
    console.error('[TEST] Error:', error);
  } finally {
    if (powersync) {
      await powersync.close();
    }
    if (separateWriteConnection) {
      separateWriteConnection.close();
    }
  }

  return results;
}

export function SimultaneousWritesScreen() {
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const runTest = async () => {
    setIsRunning(true);
    setTestResults([]);
    try {
      await runSimultaneousWritesTest((result) => {
        setTestResults(prev => [...(prev ?? []), result]);
      });
    } catch (error) {
      console.error('Error running test:', error);
      setTestResults([
        {
          name: 'Test Execution',
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <Text
        style={{
          fontSize: 20,
          fontWeight: 'bold',
          marginBottom: 10,
        }}
      >
        Simultaneous Writes Test
      </Text>

      <Button
        title="Run Simultaneous Writes Test"
        onPress={runTest}
        disabled={isRunning}
      />

      {isRunning && (
        <View style={{ marginTop: 10, alignItems: 'center' }}>
          <ActivityIndicator size="large" />
          <Text style={{ marginTop: 5 }}>Running test...</Text>
        </View>
      )}

      {testResults && (
        <View style={{ marginTop: 15 }}>
          <View
            style={{
              padding: 15,
              marginBottom: 10,
              backgroundColor: '#e7f3ff',
              borderRadius: 8,
              borderWidth: 1,
              borderColor: '#b3d9ff',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: 'bold' }}>
              Test Summary
            </Text>
            <Text style={{ fontSize: 14, marginTop: 5 }}>
              Total: {testResults.length} | Passed:{' '}
              {testResults.filter(r => r.passed).length} | Failed:{' '}
              {testResults.filter(r => !r.passed).length}
            </Text>
          </View>
          {testResults.map((result, index) => (
            <View
              key={index}
              style={{
                padding: 15,
                marginVertical: 5,
                backgroundColor: result.passed ? '#d4edda' : '#f8d7da',
                borderRadius: 8,
                borderWidth: 1,
                borderColor: result.passed ? '#c3e6cb' : '#f5c6cb',
              }}
            >
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: 'bold',
                  color: result.passed ? '#155724' : '#721c24',
                  marginBottom: 5,
                }}
              >
                {result.passed ? '✅' : '❌'} {result.name}
              </Text>
              {result.error && (
                <Text
                  style={{
                    fontSize: 14,
                    color: '#721c24',
                    marginTop: 5,
                  }}
                >
                  Error: {result.error}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
