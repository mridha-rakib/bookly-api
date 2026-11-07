import { expect, it } from "vitest";
import {
  compareRequiredIndexes as compare,
  type IndexDefinition,
} from "../../src/database/index-qualification.js";

const required: IndexDefinition = {
  key: { customerUserId: 1, createdAt: -1, _id: -1 },
  options: {
    unique: true,
    partialFilterExpression: { providerId: { $type: "string" }, state: "READY" },
  },
};
it("rejects same-count indexes with wrong compound order, direction or safety options", () => {
  for (const candidate of [
    { ...required, key: { createdAt: -1, customerUserId: 1, _id: -1 } },
    { ...required, key: { customerUserId: 1, createdAt: 1, _id: -1 } },
    { ...required, options: { ...required.options, unique: false } },
    { ...required, options: { unique: true } },
    { ...required, options: { ...required.options, hidden: true } },
    { ...required, options: { ...required.options, expireAfterSeconds: 30 } },
    { ...required, options: { ...required.options, sparse: true } },
    { ...required, options: { ...required.options, collation: { locale: "en", strength: 2 } } },
  ])
    expect(compare([required], [candidate])[0]?.state).toBe("MISSING_OR_DIFFERENT");
});

it("normalizes predicate field order and server metadata without sorting compound keys", () => {
  const actual = {
    ...required,
    options: {
      ...required.options,
      name: "server_name",
      v: 2,
      partialFilterExpression: { state: "READY", providerId: { $type: "string" } },
    },
  };
  expect(compare([required], [actual])[0]).toMatchObject({
    state: "MATCHED",
    actualName: "server_name",
  });
  expect(
    compare([{ ...required, options: { ...required.options, name: "reviewed_name" } }], [actual])[0]
      ?.state,
  ).toBe("MISSING_OR_DIFFERENT");
});

it("accounts for inherited collection collation and expanded server defaults", () => {
  const index = { key: { id: 1 }, options: {} };
  const actual = {
    ...index,
    options: {
      collation: { locale: "en", strength: 2, version: "server-version", caseLevel: false },
    },
  };
  expect(compare([index], [actual])[0]?.state).toBe("MISSING_OR_DIFFERENT");
  expect(compare([index], [actual], { locale: "en", strength: 2 })[0]?.state).toBe("MATCHED");
  expect(
    compare([{ ...index, options: { collation: { locale: "simple" } } }], [index], {
      locale: "en",
    })[0]?.state,
  ).toBe("MATCHED");
});

it("reports missing indexes and refuses unsupported index kinds instead of claiming qualification", () => {
  expect(compare([required], [])[0]?.state).toBe("MISSING_OR_DIFFERENT");
  expect(() => compare([{ key: { field: "text" }, options: {} }], [])).toThrow("B-tree");
});

it("preserves typed values and logical array ordering in partial predicates", () => {
  const index = {
    key: { id: 1 },
    options: { partialFilterExpression: { expires: { $gte: new Date(1) } } },
  };
  expect(
    compare(
      [index],
      [{ ...index, options: { partialFilterExpression: { expires: { $gte: new Date(2) } } } }],
    )[0]?.state,
  ).toBe("MISSING_OR_DIFFERENT");
});
