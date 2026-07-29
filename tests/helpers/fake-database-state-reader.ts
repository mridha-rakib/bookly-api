import type {
  DatabaseConnectionState,
  DatabaseStateReader,
} from "../../src/database/database-manager.js";

export class FakeDatabaseStateReader implements DatabaseStateReader {
  public constructor(private state: DatabaseConnectionState = "connected") {}

  public getConnectionState(): DatabaseConnectionState {
    return this.state;
  }

  public setConnectionState(state: DatabaseConnectionState): void {
    this.state = state;
  }
}
