import { isDeepStrictEqual } from "node:util";

export type IndexDefinition = {
  key: Record<string, unknown>;
  options: Record<string, unknown>;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (
    value &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};

const collation = (value: unknown): unknown => {
  if (!value || (value as Record<string, unknown>)["locale"] === "simple")
    return { locale: "simple" };
  return canonical({
    caseLevel: false,
    caseFirst: "off",
    strength: 3,
    numericOrdering: false,
    alternate: "non-ignorable",
    maxVariable: "punct",
    normalization: false,
    backwards: false,
    ...(value as Record<string, unknown>),
  });
};

/** Offline B-tree contract comparison only. No connection, provisioning, activation or repair.
 * Pass effective collection collation for declarations that inherit it. An explicit name
 * is a requirement; generated names are not. Server collation version remains evidence.
 * Callers must keep raw listIndexes output for review of server-specific metadata.
 */
export function compareRequiredIndexes(
  required: readonly IndexDefinition[],
  actual: readonly IndexDefinition[],
  collectionCollation?: Record<string, unknown>,
) {
  const normalize = (index: IndexDefinition, declared: boolean) => {
    if (!Object.keys(index.key).length || Object.values(index.key).some((v) => v !== 1 && v !== -1))
      throw Error("Index qualification supports nonempty B-tree keys only");
    const options = index.options;
    const effectiveCollation = { ...(options["collation"] as Record<string, unknown> | undefined) };
    // ICU version is reported by Mongo, not an application-selected collation option.
    delete effectiveCollation["version"];
    return {
      keys: Object.entries(index.key),
      unique: options["unique"] ?? false,
      sparse: options["sparse"] ?? false,
      hidden: options["hidden"] ?? false,
      expireAfterSeconds: options["expireAfterSeconds"] ?? null,
      partialFilterExpression: canonical(options["partialFilterExpression"] ?? null),
      collation: collation(
        Object.keys(effectiveCollation).length
          ? effectiveCollation
          : declared
            ? collectionCollation
            : undefined,
      ),
    };
  };
  const observed = actual.map((index) => normalize(index, false));
  return required.map((index) => {
    const contract = normalize(index, true);
    const matched = actual.findIndex(
      (candidate, i) =>
        (!index.options["name"] || candidate.options["name"] === index.options["name"]) &&
        isDeepStrictEqual(contract, observed[i]),
    );
    return {
      required: index,
      state: matched < 0 ? ("MISSING_OR_DIFFERENT" as const) : ("MATCHED" as const),
      actualName: matched < 0 ? null : (actual[matched]?.options["name"] ?? null),
    };
  });
}
