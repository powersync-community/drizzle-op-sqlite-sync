/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, { useEffect } from 'react';
import {
  Button,
  FlatList,
  StatusBar,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { PowerSyncContext, useQuery } from '@powersync/react-native';
import { eq } from 'drizzle-orm';
import { drizzleLists, SystemContext, useSystem } from './SystemContext';
import { toCompilableQuery } from '@powersync/drizzle-driver';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent(): React.JSX.Element {
  const system = useSystem();
  useEffect(() => {
    const initialize = async () => {
      try {
        await system.init();
        console.log('System initialized successfully');
      } catch (error) {
        console.error('Error initializing system:', error);
      }
    };
    initialize();
  }, []);

  return (
    <SystemContext.Provider value={system}>
      <PowerSyncContext.Provider value={system.powersync}>
        <SafeAreaView>
          <View
            style={{
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'space-between',
              padding: 25,
            }}
          >
            <View>
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: 'bold',
                  marginVertical: 10,
                  textAlign: 'center',
                }}
              >
                Drizzle List
              </Text>
              <DrizzleList />
            </View>
            <View>
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: 'bold',
                  marginVertical: 10,
                  textAlign: 'center',
                }}
              >
                Sync Drizzle List
              </Text>
              <SyncDrizzleList />
            </View>
          </View>
        </SafeAreaView>
      </PowerSyncContext.Provider>
    </SystemContext.Provider>
  );
}

function SyncDrizzleList() {
  const system = useSystem();

  // You can use the useQuery hook to automatically re-render on data changes
  // const { data: lists } = useQuery(
  //   toCompilableQuery(system.drizzleSync.select().from(drizzleLists)),
  // );
  // Or you can manually listen for changes and update state
  const [lists, setLists] = React.useState<any[] | undefined>([]);
  useEffect(() => {
    system.powersync.onChangeWithCallback(
      {
        onChange: () => {
          new Promise(res => {
            setLists(
              system.drizzleSync
                ?.select()
                .from(drizzleLists)
                .orderBy(drizzleLists.name)
                .all(),
            );
            res(null);
          });
        },
      },
      {
        tables: ['lists'],
      },
    );
  }, []);

  return (
    <View>
      <Button
        title="Add List"
        onPress={() => {
          system.drizzleSync
            ?.insert(drizzleLists)
            .values({
              id: generateUUID(),
              name: `List ${Math.floor(Math.random() * 1000)}`,
              owner_id: generateUUID(),
            })
            .run();
        }}
      />
      <FlatList
        data={lists}
        keyExtractor={(item, i) => item.id! + i}
        renderItem={({ item: list }) => (
          <View
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                fontSize: 16,
                marginVertical: 5,
                padding: 10,
                backgroundColor: '#f0f0f0',
                borderRadius: 5,
              }}
            >
              {list.name}
            </Text>
            <Button
              title="X"
              onPress={() => {
                system.drizzleSync
                  ?.delete(drizzleLists)
                  .where(eq(drizzleLists.id, list.id!))
                  .run();
              }}
            ></Button>
          </View>
        )}
      />
    </View>
  );
}

function DrizzleList() {
  const system = useSystem();
  const { data: lists } = useQuery(
    toCompilableQuery(
      system.drizzle.select().from(drizzleLists).orderBy(drizzleLists.name),
    ),
  );

  return (
    <View>
      <Button
        title="Add List"
        onPress={async () => {
          await system.drizzle.insert(drizzleLists).values({
            id: generateUUID(),
            name: `aList ${Math.floor(Math.random() * 1000)}`,
            owner_id: generateUUID(),
          });
        }}
      />
      <FlatList
        data={lists}
        keyExtractor={(item, i) => item.id! + i}
        renderItem={({ item: list }) => (
          <View
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                fontSize: 16,
                marginVertical: 5,
                padding: 10,
                backgroundColor: '#f0f0f0',
                borderRadius: 5,
              }}
            >
              {list.name}
            </Text>
            <Button
              title="X"
              onPress={async () => {
                await system.drizzle
                  .delete(drizzleLists)
                  .where(eq(drizzleLists.id, list.id!));
              }}
            ></Button>
          </View>
        )}
      />
    </View>
  );
}

const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export default App;
