/** Escapes user-supplied search text before it is embedded in a MongoDB regex query. */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
