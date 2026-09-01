import { z } from "zod";

import { marketingCampaignTypes } from "./marketing-campaign.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/**
 * Marketing Email Stage M3A — SUPER_ADMIN campaign API validation.
 *
 * Campaign CONTENT is never free-typed: the body carries only a `type` + a `sourceId` pointing
 * at an existing trusted row (`BlogPost` / `PromoCode`) + an optional UTC `scheduledAt`. No
 * subject, HTML, CTA URL, audience, recipient list, email array, `businessId`, `createdByUserId`,
 * or `ownerScope` is accepted — `.strict()` rejects anything else.
 */
export const createMarketingCampaignBodySchema = z
  .object({
    type: z.enum(marketingCampaignTypes),
    sourceId: objectIdSchema,
    scheduledAt: z.string().datetime().optional(),
  })
  .strict();

export const scheduleMarketingCampaignBodySchema = z
  .object({
    scheduledAt: z.string().datetime().optional(),
  })
  .strict();

export const marketingCampaignIdParamsSchema = z.object({ campaignId: objectIdSchema }).strict();

export const listMarketingCampaignsQuerySchema = z
  .object({
    page: z.string().regex(/^\d+$/, "Invalid page").optional(),
    limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
  })
  .strict()
  .transform((value) => ({
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export type CreateMarketingCampaignBody = z.infer<typeof createMarketingCampaignBodySchema>;
export type ScheduleMarketingCampaignBody = z.infer<typeof scheduleMarketingCampaignBodySchema>;
export type MarketingCampaignIdParams = z.infer<typeof marketingCampaignIdParamsSchema>;
export type ListMarketingCampaignsQuery = z.infer<typeof listMarketingCampaignsQuerySchema>;
