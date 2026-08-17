/**
 * Fixed dropdown options from the Add/Edit Client Figma — property type is a closed set, not
 * free text, mirrored 1:1 in the frontend select.
 */
export const clientPropertyTypes = [
  "Apartment",
  "Villa",
  "House",
  "Hotel",
  "Office",
  "Other",
] as const;

export type ClientPropertyType = (typeof clientPropertyTypes)[number];

/**
 * Client tags are a single-select pill in the Add/Edit Client form and a single badge per row
 * in the Clients table (Figma shows exactly one tag per client, never multiple) — modeled as
 * one optional scalar field rather than an array.
 */
export const clientTags = ["VIP", "Regular", "New", "No-show"] as const;

export type ClientTag = (typeof clientTags)[number];

/**
 * UNLINKED: no matching verified Bookly Customer account exists yet (default for every
 * Business-created Client).
 * LINKED: email AND phone both matched the SAME verified Customer — the only state that
 * overlays live User/UserProfile identity data and locks identity fields from Business edits.
 * IDENTITY_CONFLICT: a partial/crossed match was found (email matched one Customer, phone
 * matched a different one, or only one signal matched) — never auto-linked, held for future
 * manual/verified resolution.
 */
export const clientLinkStates = ["UNLINKED", "LINKED", "IDENTITY_CONFLICT"] as const;

export type ClientLinkState = (typeof clientLinkStates)[number];
