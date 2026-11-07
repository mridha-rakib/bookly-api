/** LOCAL ACCEPTANCE override (NON-PRODUCTION). Loaded only through dev/local-acceptance/hooks.mjs.
 * Batch rollout gate resolves only inside the composed local acceptance process. */
import { assertLocalAcceptanceComposed } from "../authority.js";

export * from "../../../src/modules/booking/package-batch-authority.js";

export const verifyPackageBatchActivation = async (): Promise<void> => {
  assertLocalAcceptanceComposed();
};
