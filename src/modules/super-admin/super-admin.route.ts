import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import multer from "multer";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessLifecycleService } from "../business/business-lifecycle.service.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { ClientRepository } from "../client/client.repository.js";
import { BlogError } from "../content/blog.errors.js";
import { BlogPostRepository } from "../content/blog.repository.js";
import {
  blogMediaIdParamsSchema,
  blogPostIdParamsSchema,
  createBlogBodySchema,
  listAdminBlogQuerySchema,
  updateBlogBodySchema,
} from "../content/blog.schema.js";
import { BlogService } from "../content/blog.service.js";
import { BlogMediaRepository } from "../content/blog-media.repository.js";
import { FaqRepository } from "../content/faq.repository.js";
import {
  createFaqBodySchema,
  faqIdParamsSchema,
  listAdminFaqsQuerySchema,
  reorderFaqsBodySchema,
  updateFaqBodySchema,
} from "../content/faq.schema.js";
import { FaqService } from "../content/faq.service.js";
import { StaticPageRepository } from "../content/static-page.repository.js";
import {
  staticPageKeyParamsSchema,
  updateStaticPageBodySchema,
} from "../content/static-page.schema.js";
import { StaticPageService } from "../content/static-page.service.js";
import { BusinessPayoutRepository } from "../finance/business-payout.repository.js";
import { BusinessPayoutService } from "../finance/business-payout.service.js";
import {
  executePayoutBodySchema,
  financeBusinessParamsSchema,
  financePayoutHistoryQuerySchema,
  financeSummaryQuerySchema,
  financeTransactionsQuerySchema,
  platformTransactionsQuerySchema,
} from "../finance/finance.schema.js";
import { FinanceService } from "../finance/finance.service.js";
import { MarketingAudienceService } from "../marketing/marketing-audience.service.js";
import { MarketingCampaignController } from "../marketing/marketing-campaign.controller.js";
import { MarketingCampaignRepository } from "../marketing/marketing-campaign.repository.js";
import {
  createMarketingCampaignBodySchema,
  listMarketingCampaignsQuerySchema,
  marketingCampaignIdParamsSchema,
  scheduleMarketingCampaignBodySchema,
} from "../marketing/marketing-campaign.schema.js";
import { MarketingCampaignService } from "../marketing/marketing-campaign.service.js";
import { MarketingCampaignRecipientRepository } from "../marketing/marketing-campaign-recipient.repository.js";
import { MarketingCampaignSourceService } from "../marketing/marketing-campaign-source.service.js";
import { PlatformSettingsController } from "../platform-settings/platform-settings.controller.js";
import { PlatformSettingsRepository } from "../platform-settings/platform-settings.repository.js";
import { updatePlatformSettingsBodySchema } from "../platform-settings/platform-settings.schema.js";
import { PlatformSettingsService } from "../platform-settings/platform-settings.service.js";
import { PromoRepository } from "../promo/promo.repository.js";
import {
  createPromoBodySchema,
  listPromoRedemptionsQuerySchema,
  listPromosQuerySchema,
  promoIdParamsSchema,
  setPromoStatusBodySchema,
  updatePromoBodySchema,
} from "../promo/promo.schema.js";
import { PromoService } from "../promo/promo.service.js";
import { PromoRedemptionRepository } from "../promo/promo-redemption.repository.js";
import { ReviewRepository } from "../review/review.repository.js";
import {
  listModerationReviewsQuerySchema,
  moderateReviewBodySchema,
  reviewIdParamsSchema,
} from "../review/review.schema.js";
import { ReviewService } from "../review/review.service.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import {
  changeSupportTicketStatusBodySchema,
  listAdminSupportTicketsQuerySchema,
  listSupportMessagesQuerySchema,
  supportMessageBodySchema,
  supportTicketIdParamsSchema,
} from "../support/support.schema.js";
import { SupportService } from "../support/support.service.js";
import { createSupportEmailProvider } from "../support/support-email.provider.js";
import { SupportMessageRepository } from "../support/support-message.repository.js";
import { SupportTicketRepository } from "../support/support-ticket.repository.js";
import { UserRepository } from "../user/user.repository.js";
import {
  superAdminAnalyticsPeriodQuerySchema,
  superAdminBookingIdParamsSchema,
  superAdminBusinessIdParamsSchema,
  superAdminListBookingsQuerySchema,
  superAdminListBusinessesQuerySchema,
  superAdminListCustomersQuerySchema,
  superAdminRecentActivityQuerySchema,
  superAdminRejectBusinessBodySchema,
  superAdminSetFoundingPartnerBodySchema,
  superAdminSuspendBusinessBodySchema,
  superAdminTopServicesQuerySchema,
  superAdminUserIdParamsSchema,
} from "./super-admin.schema.js";
import { SuperAdminActivityService } from "./super-admin-activity.service.js";
import { SuperAdminAnalyticsController } from "./super-admin-analytics.controller.js";
import { SuperAdminBookingController } from "./super-admin-booking.controller.js";
import { SuperAdminBookingService } from "./super-admin-booking.service.js";
import { SuperAdminBookingAnalyticsService } from "./super-admin-booking-analytics.service.js";
import { SuperAdminBusinessController } from "./super-admin-business.controller.js";
import { SuperAdminBusinessService } from "./super-admin-business.service.js";
import { SuperAdminBusinessAnalyticsService } from "./super-admin-business-analytics.service.js";
import { SuperAdminCityAnalyticsService } from "./super-admin-city-analytics.service.js";
import { SuperAdminContentController } from "./super-admin-content.controller.js";
import { SuperAdminCustomerController } from "./super-admin-customer.controller.js";
import { SuperAdminCustomerService } from "./super-admin-customer.service.js";
import { SuperAdminCustomerAnalyticsService } from "./super-admin-customer-analytics.service.js";
import { SuperAdminDashboardController } from "./super-admin-dashboard.controller.js";
import { SuperAdminDashboardService } from "./super-admin-dashboard.service.js";
import { SuperAdminFinanceController } from "./super-admin-finance.controller.js";
import { SuperAdminPromoController } from "./super-admin-promo.controller.js";
import { SuperAdminPromoService } from "./super-admin-promo.service.js";
import { SuperAdminReviewController } from "./super-admin-review.controller.js";
import { SuperAdminReviewService } from "./super-admin-review.service.js";
import { SuperAdminServiceAnalyticsService } from "./super-admin-service-analytics.service.js";
import { SuperAdminSupportController } from "./super-admin-support.controller.js";
import { SuperAdminSupportService } from "./super-admin-support.service.js";

/** Single in-memory image upload for the Blog media endpoint — same multer config as
 * business-media.route.ts (memory storage, one file, env-driven size cap). */
const blogMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.BUSINESS_MEDIA_MAX_UPLOAD_BYTES, files: 1 },
});

const uploadBlogImage: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  blogMediaUpload.single("file")(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(new BlogError("BLOG_MEDIA_TOO_LARGE", 413));
      return;
    }
    next(error);
  });
};

/**
 * Batch 8 — the first real Super Admin backend surface in this codebase (confirmed by
 * investigation: previously zero SUPER_ADMIN-gated routes existed anywhere, and
 * requireApprovedBusiness's own doc comment independently notes "a Super Admin route today has
 * zero business-management endpoints"). Every route here is SUPER_ADMIN-only, end to end, via
 * the same router-wide-gate pattern business.route.ts already established for
 * BUSINESS_OWNER-only surfaces — never a per-route role check.
 */
export const createSuperAdminRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const businessRepository = new BusinessRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const bookingRepository = new BookingRepository();
  const businessPayoutRepository = new BusinessPayoutRepository();
  const reviewRepository = new ReviewRepository();
  const businessBookingSettingsRepository = new BusinessBookingSettingsRepository();
  const serviceRepository = new ServiceRepository();

  const financeService = new FinanceService(
    businessRepository,
    financialTransactionService,
    bookingRepository,
    businessPayoutRepository,
  );
  const businessPayoutService = new BusinessPayoutService(
    businessRepository,
    financialTransactionService,
    businessPayoutRepository,
  );
  const controller = new SuperAdminFinanceController(financeService, businessPayoutService);

  const businessLifecycleService = new BusinessLifecycleService(businessRepository);
  const businessController = new SuperAdminBusinessController(
    new SuperAdminBusinessService(
      businessRepository,
      bookingRepository,
      userRepository,
      businessLifecycleService,
      reviewRepository,
      businessBookingSettingsRepository,
      serviceRepository,
    ),
  );
  const bookingController = new SuperAdminBookingController(
    new SuperAdminBookingService(bookingRepository, businessRepository),
  );
  const customerController = new SuperAdminCustomerController(
    new SuperAdminCustomerService(userRepository, bookingRepository),
  );
  const dashboardController = new SuperAdminDashboardController(
    new SuperAdminDashboardService(
      businessRepository,
      userRepository,
      bookingRepository,
      financialTransactionService,
      financeService,
      businessPayoutRepository,
    ),
  );

  const clientRepository = new ClientRepository();
  const analyticsController = new SuperAdminAnalyticsController(
    new SuperAdminBookingAnalyticsService(bookingRepository, financialTransactionService),
    new SuperAdminBusinessAnalyticsService(
      businessRepository,
      bookingRepository,
      clientRepository,
      financialTransactionService,
    ),
    new SuperAdminCustomerAnalyticsService(userRepository, bookingRepository),
    new SuperAdminServiceAnalyticsService(bookingRepository, businessRepository),
    new SuperAdminCityAnalyticsService(businessRepository),
    new SuperAdminActivityService(businessRepository, userRepository, businessPayoutRepository),
  );

  const promoRedemptionRepository = new PromoRedemptionRepository();
  const promoController = new SuperAdminPromoController(
    new SuperAdminPromoService(
      new PromoService(new PromoRepository(), businessRepository, promoRedemptionRepository),
      promoRedemptionRepository,
      businessRepository,
      userRepository,
    ),
  );

  const reviewController = new SuperAdminReviewController(
    new SuperAdminReviewService(
      new ReviewService(new ReviewRepository(), bookingRepository),
      businessRepository,
      bookingRepository,
    ),
  );

  const contentController = new SuperAdminContentController(
    new FaqService(new FaqRepository()),
    new BlogService(
      new BlogPostRepository(),
      new BlogMediaRepository(),
      createDeferredStorageServiceFromEnv(),
      { maxUploadBytes: env.BUSINESS_MEDIA_MAX_UPLOAD_BYTES },
    ),
    new StaticPageService(new StaticPageRepository()),
  );

  const supportController = new SuperAdminSupportController(
    new SuperAdminSupportService(
      new SupportService(
        new SupportTicketRepository(),
        new SupportMessageRepository(),
        bookingRepository,
        businessRepository,
        new StaffRepository(),
        userRepository,
        createSupportEmailProvider(),
      ),
      userRepository,
      businessRepository,
      bookingRepository,
    ),
  );

  const platformSettingsController = new PlatformSettingsController(
    new PlatformSettingsService(new PlatformSettingsRepository()),
  );

  // Marketing Email M3A/M3B — campaign domain + audience + cancel. The actual delivery worker
  // runs out-of-process (scripts/run-marketing-campaign-worker.ts); this API never sends.
  // SUPER_ADMIN only.
  const marketingCampaignRecipientRepository = new MarketingCampaignRecipientRepository();
  const marketingCampaignController = new MarketingCampaignController(
    new MarketingCampaignService(
      new MarketingCampaignRepository(),
      new MarketingCampaignSourceService(new BlogPostRepository(), new PromoRepository()),
      new MarketingAudienceService(userRepository, marketingCampaignRecipientRepository),
      marketingCampaignRecipientRepository,
    ),
  );

  router.use(authenticate, requireActiveUser(), requireRoles(["SUPER_ADMIN"]));

  // --- Platform Settings ---
  router.get("/settings/platform", asyncHandler(platformSettingsController.get));
  router.patch(
    "/settings/platform",
    validateRequest({ body: updatePlatformSettingsBodySchema }),
    asyncHandler(platformSettingsController.update),
  );

  // --- Marketing Email campaigns (Stage M3A — domain + audience only, NO send endpoint) ---
  router.post(
    "/marketing/campaigns",
    validateRequest({ body: createMarketingCampaignBodySchema }),
    asyncHandler(marketingCampaignController.create),
  );
  router.get(
    "/marketing/campaigns",
    validateRequest({ query: listMarketingCampaignsQuerySchema }),
    asyncHandler(marketingCampaignController.list),
  );
  router.get(
    "/marketing/campaigns/:campaignId",
    validateRequest({ params: marketingCampaignIdParamsSchema }),
    asyncHandler(marketingCampaignController.getById),
  );
  router.post(
    "/marketing/campaigns/:campaignId/schedule",
    validateRequest({
      params: marketingCampaignIdParamsSchema,
      body: scheduleMarketingCampaignBodySchema,
    }),
    asyncHandler(marketingCampaignController.schedule),
  );
  router.post(
    "/marketing/campaigns/:campaignId/materialize",
    validateRequest({ params: marketingCampaignIdParamsSchema }),
    asyncHandler(marketingCampaignController.materialize),
  );
  router.post(
    "/marketing/campaigns/:campaignId/cancel",
    validateRequest({ params: marketingCampaignIdParamsSchema }),
    asyncHandler(marketingCampaignController.cancel),
  );

  // --- Businesses ---
  router.get(
    "/businesses",
    validateRequest({ query: superAdminListBusinessesQuerySchema }),
    asyncHandler(businessController.list),
  );
  router.get(
    "/businesses/:businessId",
    validateRequest({ params: superAdminBusinessIdParamsSchema }),
    asyncHandler(businessController.getById),
  );
  router.post(
    "/businesses/:businessId/approve",
    validateRequest({ params: superAdminBusinessIdParamsSchema }),
    asyncHandler(businessController.approve),
  );
  router.post(
    "/businesses/:businessId/reject",
    validateRequest({
      params: superAdminBusinessIdParamsSchema,
      body: superAdminRejectBusinessBodySchema,
    }),
    asyncHandler(businessController.reject),
  );
  router.post(
    "/businesses/:businessId/suspend",
    validateRequest({
      params: superAdminBusinessIdParamsSchema,
      body: superAdminSuspendBusinessBodySchema,
    }),
    asyncHandler(businessController.suspend),
  );
  router.patch(
    "/businesses/:businessId/founding-partner",
    validateRequest({
      params: superAdminBusinessIdParamsSchema,
      body: superAdminSetFoundingPartnerBodySchema,
    }),
    asyncHandler(businessController.setFoundingPartner),
  );

  // --- Global Bookings ---
  router.get(
    "/bookings",
    validateRequest({ query: superAdminListBookingsQuerySchema }),
    asyncHandler(bookingController.list),
  );
  router.get(
    "/bookings/:bookingId",
    validateRequest({ params: superAdminBookingIdParamsSchema }),
    asyncHandler(bookingController.getById),
  );

  // --- Global Customers ---
  router.get(
    "/customers",
    validateRequest({ query: superAdminListCustomersQuerySchema }),
    asyncHandler(customerController.list),
  );
  router.get(
    "/customers/:userId",
    validateRequest({ params: superAdminUserIdParamsSchema }),
    asyncHandler(customerController.getById),
  );

  // --- Dashboard ---
  router.get("/dashboard/summary", asyncHandler(dashboardController.getSummary));

  // --- Analytics ---
  router.get(
    "/analytics/bookings",
    validateRequest({ query: superAdminAnalyticsPeriodQuerySchema }),
    asyncHandler(analyticsController.getBookingAnalytics),
  );
  router.get(
    "/analytics/businesses",
    validateRequest({ query: superAdminAnalyticsPeriodQuerySchema }),
    asyncHandler(analyticsController.getBusinessAnalytics),
  );
  router.get(
    "/analytics/customers",
    validateRequest({ query: superAdminAnalyticsPeriodQuerySchema }),
    asyncHandler(analyticsController.getCustomerAnalytics),
  );
  router.get(
    "/analytics/top-services",
    validateRequest({ query: superAdminTopServicesQuerySchema }),
    asyncHandler(analyticsController.getTopServices),
  );
  router.get("/analytics/cities", asyncHandler(analyticsController.getCityCoverage));
  router.get(
    "/analytics/recent-activity",
    validateRequest({ query: superAdminRecentActivityQuerySchema }),
    asyncHandler(analyticsController.getRecentActivity),
  );

  // --- Promo Codes ---
  router.get(
    "/promo-codes",
    validateRequest({ query: listPromosQuerySchema }),
    asyncHandler(promoController.list),
  );
  router.get(
    "/promo-codes/:promoId",
    validateRequest({ params: promoIdParamsSchema }),
    asyncHandler(promoController.getById),
  );
  router.post(
    "/promo-codes",
    validateRequest({ body: createPromoBodySchema }),
    asyncHandler(promoController.create),
  );
  router.patch(
    "/promo-codes/:promoId",
    validateRequest({ params: promoIdParamsSchema, body: updatePromoBodySchema }),
    asyncHandler(promoController.update),
  );
  router.post(
    "/promo-codes/:promoId/status",
    validateRequest({ params: promoIdParamsSchema, body: setPromoStatusBodySchema }),
    asyncHandler(promoController.setStatus),
  );
  router.delete(
    "/promo-codes/:promoId",
    validateRequest({ params: promoIdParamsSchema }),
    asyncHandler(promoController.deletePromo),
  );
  router.get(
    "/promo-codes/:promoId/redemptions",
    validateRequest({ params: promoIdParamsSchema, query: listPromoRedemptionsQuerySchema }),
    asyncHandler(promoController.listRedemptions),
  );

  // --- Reviews (Batch 14) ---
  router.get(
    "/reviews",
    validateRequest({ query: listModerationReviewsQuerySchema }),
    asyncHandler(reviewController.list),
  );
  router.get(
    "/reviews/:reviewId",
    validateRequest({ params: reviewIdParamsSchema }),
    asyncHandler(reviewController.getById),
  );
  router.post(
    "/reviews/:reviewId/moderate",
    validateRequest({ params: reviewIdParamsSchema, body: moderateReviewBodySchema }),
    asyncHandler(reviewController.moderate),
  );

  // --- Content Manager: FAQ (Phase 1) ---
  // Every route below is SUPER_ADMIN-only via the router-wide gate above. Public reads live on
  // the separate anonymous `/content` router (see content.route.ts) — never here.
  router.get(
    "/content/faqs",
    validateRequest({ query: listAdminFaqsQuerySchema }),
    asyncHandler(contentController.listFaqs),
  );
  router.post(
    "/content/faqs",
    validateRequest({ body: createFaqBodySchema }),
    asyncHandler(contentController.createFaq),
  );
  // Registered before the `:faqId` param routes: distinct method+path, but keeping the literal
  // path first avoids any future ambiguity.
  router.post(
    "/content/faqs/reorder",
    validateRequest({ body: reorderFaqsBodySchema }),
    asyncHandler(contentController.reorderFaqs),
  );
  router.patch(
    "/content/faqs/:faqId",
    validateRequest({ params: faqIdParamsSchema, body: updateFaqBodySchema }),
    asyncHandler(contentController.updateFaq),
  );
  router.delete(
    "/content/faqs/:faqId",
    validateRequest({ params: faqIdParamsSchema }),
    asyncHandler(contentController.deleteFaq),
  );

  // --- Content Manager: Blog (Phase 2) ---
  // SUPER_ADMIN-only via the router-wide gate. Public PUBLISHED-only reads live on the anonymous
  // `/content` router (content.route.ts). Media routes are registered before `/:postId` so
  // `DELETE /content/blog/media/:mediaId` is never captured by `DELETE /content/blog/:postId`.
  router.post(
    "/content/blog/media",
    uploadBlogImage,
    asyncHandler(contentController.uploadBlogMedia),
  );
  router.delete(
    "/content/blog/media/:mediaId",
    validateRequest({ params: blogMediaIdParamsSchema }),
    asyncHandler(contentController.deleteBlogMedia),
  );
  router.get(
    "/content/blog",
    validateRequest({ query: listAdminBlogQuerySchema }),
    asyncHandler(contentController.listBlog),
  );
  router.post(
    "/content/blog",
    validateRequest({ body: createBlogBodySchema }),
    asyncHandler(contentController.createBlog),
  );
  router.get(
    "/content/blog/:postId",
    validateRequest({ params: blogPostIdParamsSchema }),
    asyncHandler(contentController.getBlog),
  );
  router.patch(
    "/content/blog/:postId",
    validateRequest({ params: blogPostIdParamsSchema, body: updateBlogBodySchema }),
    asyncHandler(contentController.updateBlog),
  );
  router.delete(
    "/content/blog/:postId",
    validateRequest({ params: blogPostIdParamsSchema }),
    asyncHandler(contentController.deleteBlog),
  );

  // --- Content Manager: Static Pages (Phase 3) ---
  // Fixed set of 4 legal pages — list + read + update only (no create/delete). Always-live
  // (no status). Public PUBLISHED-safe reads live on the anonymous `/content/pages/:pageKey`
  // router (content.route.ts).
  router.get("/content/pages", asyncHandler(contentController.listStaticPages));
  router.get(
    "/content/pages/:pageKey",
    validateRequest({ params: staticPageKeyParamsSchema }),
    asyncHandler(contentController.getStaticPage),
  );
  router.patch(
    "/content/pages/:pageKey",
    validateRequest({ params: staticPageKeyParamsSchema, body: updateStaticPageBodySchema }),
    asyncHandler(contentController.updateStaticPage),
  );

  // --- Support Tickets (Batch 15B) ---
  router.get(
    "/support/tickets",
    validateRequest({ query: listAdminSupportTicketsQuerySchema }),
    asyncHandler(supportController.list),
  );
  router.get(
    "/support/tickets/:ticketId",
    validateRequest({ params: supportTicketIdParamsSchema }),
    asyncHandler(supportController.getById),
  );
  router.get(
    "/support/tickets/:ticketId/messages",
    validateRequest({ params: supportTicketIdParamsSchema, query: listSupportMessagesQuerySchema }),
    asyncHandler(supportController.listMessages),
  );
  router.post(
    "/support/tickets/:ticketId/messages",
    validateRequest({ params: supportTicketIdParamsSchema, body: supportMessageBodySchema }),
    asyncHandler(supportController.reply),
  );
  router.post(
    "/support/tickets/:ticketId/status",
    validateRequest({
      params: supportTicketIdParamsSchema,
      body: changeSupportTicketStatusBodySchema,
    }),
    asyncHandler(supportController.changeStatus),
  );
  router.post(
    "/support/tickets/:ticketId/reopen",
    validateRequest({ params: supportTicketIdParamsSchema }),
    asyncHandler(supportController.reopen),
  );

  // --- Platform-wide ---
  router.get(
    "/finance/summary",
    validateRequest({ query: financeSummaryQuerySchema }),
    asyncHandler(controller.getPlatformSummary),
  );
  router.get(
    "/finance/transactions",
    validateRequest({ query: platformTransactionsQuerySchema }),
    asyncHandler(controller.listPlatformTransactions),
  );
  router.get("/finance/pending-payouts", asyncHandler(controller.listPendingPayouts));
  router.get(
    "/finance/promo-discounts",
    validateRequest({ query: financeSummaryQuerySchema }),
    asyncHandler(promoController.getDiscountedMoney),
  );
  router.get(
    "/finance/payouts",
    validateRequest({ query: financePayoutHistoryQuerySchema }),
    asyncHandler(controller.listPlatformPayoutHistory),
  );

  // --- Per-Business (Business Detail Finance tab) ---
  router.get(
    "/businesses/:businessId/finance/summary",
    validateRequest({ params: financeBusinessParamsSchema, query: financeSummaryQuerySchema }),
    asyncHandler(controller.getBusinessSummary),
  );
  router.get(
    "/businesses/:businessId/finance/transactions",
    validateRequest({ params: financeBusinessParamsSchema, query: financeTransactionsQuerySchema }),
    asyncHandler(controller.listBusinessTransactions),
  );
  router.get(
    "/businesses/:businessId/finance/payable",
    validateRequest({ params: financeBusinessParamsSchema }),
    asyncHandler(controller.getBusinessPayable),
  );
  router.get(
    "/businesses/:businessId/finance/payouts",
    validateRequest({
      params: financeBusinessParamsSchema,
      query: financePayoutHistoryQuerySchema,
    }),
    asyncHandler(controller.listBusinessPayoutHistory),
  );
  router.post(
    "/businesses/:businessId/finance/payouts",
    validateRequest({ params: financeBusinessParamsSchema, body: executePayoutBodySchema }),
    asyncHandler(controller.executePayout),
  );

  return router;
};
