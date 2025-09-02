# PowerSync Drizzle Driver

This package (`@powersync-community/drizzle-op-sqlite-sync`) brings the benefits of an ORM to your *synchronous* React Native applications by integrating Drizzle ORM with the `op-sqlite` database.

## Alpha Release

The `drizzle-op-sqlite-sync` package is currently in an Alpha release.

## Demo Project

A demo project is available in the `demo` folder of this repository. It is a React Native project that uses bare bones React Native to run on iOS and Android.

To run the demo project:

1. Navigate to the `demo` folder
2. Run `pnpm install` to install dependencies
3. Run `pnpm run start` to start the Metro bundler
4. In another terminal, run `pnpm run ios` or `pnpm run android`

If you encounter any issues, please refer to the [React Native Getting Started guide](https://reactnative.dev/docs/environment-setup) to ensure your environment is set up correctly.

## Getting Started

Set up the PowerSync Database and wrap it with Drizzle.

```js
import { relations } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzle } from '@powersync-community/drizzle-op-sqlite-sync';

const lists = sqliteTable('lists', {
  id: text('id'),
  name: text('name'),
  owner_id: text('owner_id')
});

const opSqlite = open({
  name: 'my-database.db'
});

// This is the DB you will use in queries
const db = drizzle(opSqlite, {
  schema: {
    lists
  }
});

const allLists = db.select().from(lists).all();
console.log(allLists); // [{ id: '1', name: 'My List' }]
```
