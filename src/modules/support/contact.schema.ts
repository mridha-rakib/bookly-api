import { z } from "zod";

// Deliberately NOT a SupportTicket body — no bookingId/businessId, no requester identity beyond
// what the submitter freely types (Q1: Public Contact stays a simple, unauthenticated message,
// never a Ticket).
export const submitContactBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email(),
    subject: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(2000),
  })
  .strict();

export type SubmitContactBody = z.infer<typeof submitContactBodySchema>;
