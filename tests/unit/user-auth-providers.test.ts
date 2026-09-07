import { describe, expect, it } from "vitest";

import {
  assertUserAuthProvidersConsistent,
  authProviders,
  resolveAuthProviders,
} from "../../src/modules/user/user.types.js";

describe("user authProviders — social providers", () => {
  it("PASSWORD, GOOGLE, FACEBOOK and APPLE are the recognised providers", () => {
    expect([...authProviders]).toEqual(["PASSWORD", "GOOGLE", "FACEBOOK", "APPLE"]);
  });

  it("an APPLE-only user (no passwordHash) is consistent", () => {
    expect(() =>
      assertUserAuthProvidersConsistent({ authProviders: ["APPLE"], passwordHash: undefined }),
    ).not.toThrow();
  });

  it("an APPLE-only user that still declares a passwordHash is rejected", () => {
    expect(() =>
      assertUserAuthProvidersConsistent({ authProviders: ["APPLE"], passwordHash: "argon-hash" }),
    ).toThrow(/mismatch/i);
  });

  it("a FACEBOOK-only user (no passwordHash) is consistent", () => {
    expect(() =>
      assertUserAuthProvidersConsistent({ authProviders: ["FACEBOOK"], passwordHash: undefined }),
    ).not.toThrow();
  });

  it("a FACEBOOK-only user that still declares a passwordHash is rejected", () => {
    expect(() =>
      assertUserAuthProvidersConsistent({
        authProviders: ["FACEBOOK"],
        passwordHash: "argon-hash",
      }),
    ).toThrow(/mismatch/i);
  });

  it("PASSWORD + FACEBOOK together requires a passwordHash", () => {
    expect(() =>
      assertUserAuthProvidersConsistent({
        authProviders: ["PASSWORD", "FACEBOOK"],
        passwordHash: "argon-hash",
      }),
    ).not.toThrow();
    expect(() =>
      assertUserAuthProvidersConsistent({
        authProviders: ["PASSWORD", "FACEBOOK"],
        passwordHash: undefined,
      }),
    ).toThrow(/mismatch/i);
  });

  it("resolveAuthProviders still defaults an absent list to PASSWORD", () => {
    expect(resolveAuthProviders(undefined)).toEqual(["PASSWORD"]);
    expect(resolveAuthProviders(["FACEBOOK"])).toEqual(["FACEBOOK"]);
    expect(resolveAuthProviders(["APPLE"])).toEqual(["APPLE"]);
  });
});
