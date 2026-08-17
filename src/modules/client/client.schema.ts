import { z } from "zod";

import { businessCities } from "../business/business.types.js";
import { genders } from "../user/user.types.js";
import { clientPropertyTypes, clientTags } from "./client.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const clientBusinessParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const clientIdParamsSchema = z
  .object({ businessId: objectIdSchema, clientId: objectIdSchema })
  .strict();

export const listClientsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    tag: z.enum(clientTags).optional(),
    archived: z.enum(["true", "false"]).optional(),
    page: z.string().regex(/^\d+$/, "Invalid page").optional(),
    limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
  })
  .strict()
  .transform((value) => ({
    q: value.q,
    tag: value.tag,
    archived: value.archived === "true",
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

const phoneBodySchema = z
  .object({
    countryCode: z.string().trim().min(1).max(5),
    nationalNumber: z.string().trim().min(4).max(15),
  })
  .strict();

const addressBodySchema = z
  .object({
    city: z.enum(businessCities),
    propertyType: z.enum(clientPropertyTypes),
    area: z.string().trim().min(1).max(200),
    streetName: z.string().trim().min(1).max(200),
    streetNumber: z.string().trim().min(1).max(50),
    floorUnit: z.string().trim().max(50).optional(),
    aptRoom: z.string().trim().max(50).optional(),
    additionalDirections: z.string().trim().max(500).optional(),
  })
  .strict();

// Every Figma-starred field (first name, phone, email, city, property type, area, street name,
// street number) is required here — the current mock UI only truly enforced first name + phone
// via a disabled-button check; this schema is what makes the rest of the asterisks real.
const clientBodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(320),
    phone: phoneBodySchema,
    dateOfBirth: z.string().trim().max(50).optional(),
    gender: z.enum(genders).optional(),
    address: addressBodySchema,
    notes: z.string().trim().max(2000).optional(),
    tag: z.enum(clientTags).optional(),
  })
  .strict();

export const createClientBodySchema = clientBodySchema;

// A partial update — every field optional. When the target Client is LINKED, the service layer
// (not this schema, which has no notion of current DB state) rejects the request outright if
// ANY identity field (firstName/lastName/email/phone/gender) is present at all — see
// client.service.ts updateClient / CLIENT_IDENTITY_LOCKED.
export const updateClientBodySchema = clientBodySchema.partial();

export type ClientBusinessParams = z.infer<typeof clientBusinessParamsSchema>;
export type ClientIdParams = z.infer<typeof clientIdParamsSchema>;
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
export type CreateClientBody = z.infer<typeof createClientBodySchema>;
export type UpdateClientBody = z.infer<typeof updateClientBodySchema>;
