import { describe, expect, it } from "vitest";

import { HealthRepository } from "../../src/modules/health/health.repository.js";
import { HealthService } from "../../src/modules/health/health.service.js";
import { FakeDatabaseStateReader } from "../helpers/fake-database-state-reader.js";

const createHealthService = (databaseStateReader = new FakeDatabaseStateReader()) =>
  new HealthService(new HealthRepository(databaseStateReader));

describe("HealthService", () => {
  it("returns lightweight liveness without database state", () => {
    const service = createHealthService(new FakeDatabaseStateReader("disconnected"));

    const liveness = service.getLiveness();

    expect(liveness.status).toBe("ok");
    expect(liveness.application).toBe("Bookly API");
    expect(liveness).not.toHaveProperty("database");
  });

  it("marks readiness ready only when MongoDB is connected", () => {
    const databaseStateReader = new FakeDatabaseStateReader("connected");
    const service = createHealthService(databaseStateReader);

    expect(service.getReadiness().status).toBe("ready");
    expect(service.isReady()).toBe(true);

    databaseStateReader.setConnectionState("disconnected");

    expect(service.getReadiness().status).toBe("not_ready");
    expect(service.isReady()).toBe(false);
  });
});
