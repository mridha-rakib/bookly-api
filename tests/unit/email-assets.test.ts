import { describe, expect, it } from "vitest";

import {
  BOOKLY_EMAIL_CID,
  booklyIconAttachment,
  booklyWordmarkAttachment,
  getBooklyIconBuffer,
  getBooklyWordmarkBuffer,
} from "../../src/modules/email/assets/bookly-email-assets.js";

/** MAILING STAGE A — brand asset Base64/CID strategy (Phase E/F). Part Y items 11–14. */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("bookly email brand assets", () => {
  it("11 wordmark Base64 decodes to a non-empty valid PNG Buffer", () => {
    const buffer = getBooklyWordmarkBuffer();
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("12 icon Base64 decodes to a non-empty valid PNG Buffer", () => {
    const buffer = getBooklyIconBuffer();
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("13 decodes once and reuses the cached Buffer instance", () => {
    expect(getBooklyWordmarkBuffer()).toBe(getBooklyWordmarkBuffer());
    expect(getBooklyIconBuffer()).toBe(getBooklyIconBuffer());
  });

  it("14 exposes stable canonical CID ids used by the attachments", () => {
    expect(BOOKLY_EMAIL_CID).toEqual({ wordmark: "bookly-wordmark", icon: "bookly-icon" });
    expect(booklyWordmarkAttachment()).toMatchObject({
      filename: "bookly-wordmark.png",
      type: "image/png",
      disposition: "inline",
      contentId: "bookly-wordmark",
    });
    expect(booklyIconAttachment()).toMatchObject({
      disposition: "inline",
      contentId: "bookly-icon",
    });
  });
});
