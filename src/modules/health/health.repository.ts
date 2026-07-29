import type {
  DatabaseConnectionState,
  DatabaseStateReader,
} from "../../database/database-manager.js";

export class HealthRepository {
  public constructor(private readonly databaseStateReader: DatabaseStateReader) {}

  public getDatabaseConnectionState(): DatabaseConnectionState {
    return this.databaseStateReader.getConnectionState();
  }
}
