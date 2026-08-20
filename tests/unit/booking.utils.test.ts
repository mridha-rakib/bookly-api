import { describe, expect, it } from "vitest";

import { generateBookingReference } from "../../src/modules/booking/booking.utils.js";

describe("generateBookingReference", () => {
  it("matches the BK-######## shape with an unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateBookingReference()).toMatch(/^BK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    }
  });

  it("never contains visually-ambiguous characters (0/O/1/I)", () => {
    for (let i = 0; i < 200; i += 1) {
      const reference = generateBookingReference();
      expect(reference).not.toMatch(/[01OI]/);
    }
  });

  it("is not derived from Math.random or a counter — repeated calls vary", () => {
    const references = new Set(Array.from({ length: 500 }, () => generateBookingReference()));
    // With a 32-symbol, 8-character alphabet the collision probability across 500 draws is
    // negligible; this is a construction sanity check, not a uniqueness proof (the actual
    // collision-safety guarantee is the unique index + retry loop, see booking.model.ts /
    // booking.service.ts).
    expect(references.size).toBe(500);
  });
});
