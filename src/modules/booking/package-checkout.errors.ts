/** Expected checkout identity, eligibility, freshness or presentation conflict.
 * Internal diagnostic text is retained for callers/tests; the HTTP adapter emits
 * its fixed safe 409 response. Dependency/programming failures are never wrapped.
 */
export class PackageCheckoutConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PackageCheckoutConflictError";
  }
}
