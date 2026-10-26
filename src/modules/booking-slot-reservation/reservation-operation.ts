import { z } from "zod";

/** Reserved for future server-correlated initial Package Bookings. This pure DTO
 * is NOT authentication, retained-quote provenance or permission to activate. */
export const PACKAGE_INITIAL_RESERVATION_PREFIX = "bookly:package-initial:v1:";
const packageKeyPattern = new RegExp(
  `^${PACKAGE_INITIAL_RESERVATION_PREFIX}[a-f0-9]{24}:[a-f0-9]{24}$`,
);
export const isPackageInitialReservationKey = (key: string): boolean =>
  packageKeyPattern.test(key.trim());
const objectIdHex = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/)
  .transform((value) => value.toLowerCase());
export const packageInitialReservationOperationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("PACKAGE_INITIAL_APPOINTMENT"),
    businessId: objectIdHex,
    bookingId: objectIdHex,
    batchId: objectIdHex,
    selectionId: objectIdHex,
  })
  .strict();
export type PackageInitialReservationOperation = z.infer<
  typeof packageInitialReservationOperationSchema
>;

/** One initial, single-line Package appointment per retained Booking. Batch and
 * selection are correlation evidence, NOT alternative ways to reserve this Booking. */
export function packageInitialReservationKey(input: unknown): string {
  const operation = packageInitialReservationOperationSchema.parse(input);
  return `${PACKAGE_INITIAL_RESERVATION_PREFIX}${operation.businessId}:${operation.bookingId}`;
}

export const originalReservationIntentSchema = z
  .object({
    version: z.literal(1),
    startAt: z.date(),
    endAt: z.date(),
    timezone: z.string().min(1),
    capacityMax: z.number().int().positive(),
    packageOperation: packageInitialReservationOperationSchema.optional(),
  })
  .strict()
  .refine((value) => value.endAt > value.startAt, "Invalid original interval");
export type OriginalReservationIntent = z.infer<typeof originalReservationIntentSchema>;
