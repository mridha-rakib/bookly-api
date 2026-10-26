/** B1c has no supported strict-deadline activation authority. This module deliberately has
 * no grant factory, configuration switch or caller-supplied authorization predicate.
 * Persistence engineering tests may mock this module; shipped callers always fail closed.
 */
export class PackageBatchActivationUnavailableError extends Error {
  public readonly code = "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE";
  public readonly statusCode = 503;

  public constructor() {
    super("First-class Package activation requires a supported B1c authority");
    this.name = "PackageBatchActivationUnavailableError";
  }
}

export const verifyPackageBatchActivation = async (): Promise<never> => {
  throw new PackageBatchActivationUnavailableError();
};
