import { describe, expect, it } from "vitest";

import { HealthRepository } from "../../src/modules/health/health.repository.js";
import { FakeDatabaseStateReader } from "../helpers/fake-database-state-reader.js";

describe("HealthRepository", () => {
  it("returns the injected database connection state", () => {
    const databaseStateReader = new FakeDatabaseStateReader("disconnecting");
    const repository = new HealthRepository(databaseStateReader);

    expect(repository.getDatabaseConnectionState()).toBe("disconnecting");
  });
});
