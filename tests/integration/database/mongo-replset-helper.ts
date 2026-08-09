import { randomUUID } from "node:crypto";

import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import mongoose from "mongoose";

let replSet: MongoMemoryReplSet | undefined;

export const startIsolatedReplicaSet = async (): Promise<string> => {
  if (!replSet) {
    replSet = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: "wiredTiger",
      },
    });
  }

  return replSet.getUri();
};

export const connectIsolatedDatabase = async (): Promise<string> => {
  const uri = await startIsolatedReplicaSet();
  const databaseName = `bookly_auth_${process.pid}_${randomUUID().replaceAll("-", "")}`;

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(uri, {
    dbName: databaseName,
    autoIndex: true,
    serverSelectionTimeoutMS: 10_000,
  });

  await Promise.all(
    mongoose.modelNames().map((modelName) => mongoose.model(modelName).syncIndexes()),
  );
  return databaseName;
};

export const clearIsolatedDatabase = async (): Promise<void> => {
  const database = mongoose.connection.db;

  if (!database) {
    return;
  }

  const collections = await database.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
};

export const disconnectIsolatedDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
};

export const stopIsolatedReplicaSet = async (): Promise<void> => {
  await disconnectIsolatedDatabase();
  await replSet?.stop();
  replSet = undefined;
};
