import { requireDevelopmentClock } from "../clock.js";

export * from "../../../src/modules/booking/package-batch-authority.js";
export async function verifyPackageBatchActivation(): Promise<void> {
  requireDevelopmentClock();
}
