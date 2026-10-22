import { describe, expect, it } from "vitest";
import {
  calculatePackageLifetimeCaptureCap,
  PACKAGE_SESSION_PENALTY_POLICY,
} from "../../src/modules/packages/package-session-penalty-policy.js";

describe("fixed inactive Package Option B policy v1", () => {
  it("keeps platform limits immutable and distinct from reference prices", () => {
    expect(PACKAGE_SESSION_PENALTY_POLICY).toEqual({
      version: 1,
      currency: "EUR",
      maxBasisCents: 5000,
      appointmentCaptureCapCents: 2500,
      lifetimeCaptureCapCents: 10000,
    });
    expect(Object.isFrozen(PACKAGE_SESSION_PENALTY_POLICY)).toBe(true);
  });
  it.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [50, 25],
    [3000, 1500],
    [19999, 9999],
    [20000, 10000],
    [20001, 10000],
    [Number.MAX_SAFE_INTEGER, 10000],
  ])("sold bundle %i yields lifetime capture cap %i", (bundle, expected) => {
    expect(calculatePackageLifetimeCaptureCap(bundle)).toBe(expected);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity])(
    "rejects invalid sold cents %s",
    (bundle) => {
      expect(() => calculatePackageLifetimeCaptureCap(bundle)).toThrow(RangeError);
    },
  );
});
