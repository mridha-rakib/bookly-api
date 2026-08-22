/**
 * PENDING/HELD-style temporary reservations are not implemented in this batch — every
 * reservation this batch creates is immediately CONFIRMED. The field exists now so a future
 * batch can add a time-limited hold (e.g. "slot held for 5 minutes while the customer pays")
 * without a schema migration — see booking-slot-reservation.model.ts's own doc comment.
 */
export const bookingSlotReservationStatuses = ["CONFIRMED"] as const;
export type BookingSlotReservationStatus = (typeof bookingSlotReservationStatuses)[number];
