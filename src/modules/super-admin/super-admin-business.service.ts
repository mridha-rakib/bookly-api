import type { BookingRepository } from "../booking/booking.repository.js";
import { BusinessError } from "../business/business.errors.js";
import type { BusinessAddress, BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessStatus, BusinessVisitType } from "../business/business.types.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessLifecycleService } from "../business/business-lifecycle.service.js";
import type { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import type { ReviewAggregate, ReviewRepository } from "../review/review.repository.js";
import type {
  ServiceRepository,
  ServiceScheduleModeCounts,
} from "../services/service.repository.js";
import type { UserDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";

/** Booking mode is a per-Service setting (Service.scheduleMode) — there is no business-wide
 * mode. This is the business-level rollup the Super Admin header badge shows:
 *   AUTO   = every ACTIVE service follows the Business's general hours
 *   MANUAL = every ACTIVE service defines its own fixed times
 *   MIXED  = both kinds exist
 *   null   = the Business has no ACTIVE service yet (badge is omitted, never guessed) */
export type SuperAdminBusinessBookingMode = "AUTO" | "MANUAL" | "MIXED" | null;

const deriveBookingMode = (counts: ServiceScheduleModeCounts): SuperAdminBusinessBookingMode => {
  if (counts.auto > 0 && counts.manual > 0) return "MIXED";
  if (counts.auto > 0) return "AUTO";
  if (counts.manual > 0) return "MANUAL";
  return null;
};

export type SuperAdminBusinessListItemDto = {
  id: string;
  name: string;
  category: string;
  visitType: BusinessVisitType;
  city: string;
  status: BusinessStatus;
  /** The Reviews & Ratings system (Batch 14) does expose a real per-Business published aggregate
   * (see ReviewRepository.getAggregate), but the Super Admin Business LIST intentionally does not
   * fan out one aggregate query per row — that would be an N+1 on the paginated list. The
   * per-Business rating is surfaced on the Business DETAIL DTO instead (getDetail below). These
   * stay null here until a batched list aggregate is added; they are never fabricated. */
  rating: null;
  reviewsCount: null;
  bookingsCount: number;
  memberSince: string;
};

export type SuperAdminBusinessListResult = {
  businesses: SuperAdminBusinessListItemDto[];
  pagination: { page: number; limit: number; total: number };
  counts: Record<BusinessStatus, number> & { ALL: number };
};

export type SuperAdminBusinessDetailDto = {
  id: string;
  name: string;
  ownerName: string;
  status: BusinessStatus;
  visitType: BusinessVisitType;
  timezone: string;
  phone: { countryCode: string; nationalNumber: string; e164: string };
  address: BusinessAddress;
  briefDescription: string;
  category: string;
  subcategories: string[];
  owner: { id: string; email: string; status: string; lastLoginAt: string | null };
  /** Published-review aggregate for this Business (Batch 14 — ReviewRepository.getAggregate,
   * the single existing on-demand aggregation, reused here — never a second calculation).
   * `rating` is null when there are no PUBLISHED reviews (`reviewsCount === 0`); it is never a
   * fabricated 0.0. */
  rating: number | null;
  reviewsCount: number;
  /** Business-scoped Gap Elimination toggle (BusinessBookingSettings.gapEliminationEnabled).
   * Defaults to false when the Business has no settings document yet — the same default the
   * owning BusinessBookingSettingsService applies. */
  gapEliminationEnabled: boolean;
  /** Business-level rollup of the per-Service `scheduleMode` (see SuperAdminBusinessBookingMode).
   * null only when the Business has no ACTIVE service — the header omits the badge, never
   * fabricates a mode. */
  bookingMode: SuperAdminBusinessBookingMode;
  /** Explicit Super Admin-controlled marketing flag (Business.isFoundingPartner). Never
   * inferred. */
  isFoundingPartner: boolean;
  bookingsCount: number;
  statusHistory: Array<{
    fromStatus: BusinessStatus;
    toStatus: BusinessStatus;
    actorUserId: string;
    actorEmail?: string;
    reason?: string;
    changedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export class SuperAdminBusinessService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly userRepository: UserRepository,
    private readonly lifecycleService: BusinessLifecycleService,
    private readonly reviewRepository: ReviewRepository,
    private readonly businessBookingSettingsRepository: BusinessBookingSettingsRepository,
    private readonly serviceRepository: ServiceRepository,
  ) {}

  public async list(
    filter: {
      status?: BusinessStatus | undefined;
      visitType?: BusinessVisitType | undefined;
      city?: string | undefined;
      category?: string | undefined;
      q?: string | undefined;
    },
    pagination: { page: number; limit: number },
  ): Promise<SuperAdminBusinessListResult> {
    const [{ businesses, total }, statusCounts] = await Promise.all([
      this.businessRepository.listForSuperAdmin(filter, pagination),
      this.businessRepository.countByStatus(),
    ]);

    const bookingCounts = await this.bookingRepository.countByBusinessIds(
      businesses.map((b) => b._id),
    );

    return {
      businesses: businesses.map((business) => this.toListItemDto(business, bookingCounts)),
      pagination: { page: pagination.page, limit: pagination.limit, total },
      counts: {
        ALL:
          statusCounts.PENDING +
          statusCounts.APPROVED +
          statusCounts.WARNING +
          statusCounts.SUSPENDED,
        ...statusCounts,
      },
    };
  }

  public async getDetail(businessId: string): Promise<SuperAdminBusinessDetailDto> {
    const business = await this.requireBusiness(businessId);

    const actorIds = [...new Set(business.statusHistory.map((entry) => String(entry.actorUserId)))];
    const [owner, bookingCounts, actors, ratingAggregate, bookingSettings, scheduleModeCounts] =
      await Promise.all([
        this.userRepository.findById(business.ownerUserId),
        this.bookingRepository.countByBusinessIds([business._id]),
        this.userRepository.findManyByIds(actorIds),
        this.reviewRepository.getAggregate(business._id),
        this.businessBookingSettingsRepository.findByBusinessId(business._id),
        this.serviceRepository.countActiveByScheduleMode(business._id),
      ]);
    const actorEmailById = new Map(
      actors.map((actor) => [String(actor._id), actor.normalizedEmail]),
    );

    return this.toDetailDto(
      business,
      owner,
      bookingCounts.get(String(business._id)) ?? 0,
      actorEmailById,
      ratingAggregate,
      bookingSettings?.gapEliminationEnabled ?? false,
      deriveBookingMode(scheduleModeCounts),
    );
  }

  public async approve(
    superAdminUserId: string,
    businessId: string,
  ): Promise<SuperAdminBusinessDetailDto> {
    await this.lifecycleService.approveBusiness(superAdminUserId, businessId);
    return this.getDetail(businessId);
  }

  public async reject(
    superAdminUserId: string,
    businessId: string,
    reason: string | undefined,
  ): Promise<SuperAdminBusinessDetailDto> {
    await this.lifecycleService.rejectBusiness(superAdminUserId, businessId, reason);
    return this.getDetail(businessId);
  }

  public async suspend(
    superAdminUserId: string,
    businessId: string,
    reason: string | undefined,
  ): Promise<SuperAdminBusinessDetailDto> {
    await this.lifecycleService.suspendBusiness(superAdminUserId, businessId, reason);
    return this.getDetail(businessId);
  }

  /** Explicit Super Admin toggle of `Business.isFoundingPartner` (both directions). A plain
   * attribute set — not a lifecycle transition — so no statusHistory/CAS. */
  public async setFoundingPartner(
    businessId: string,
    isFoundingPartner: boolean,
  ): Promise<SuperAdminBusinessDetailDto> {
    await this.requireBusiness(businessId);
    const updated = await this.businessRepository.setFoundingPartner(businessId, isFoundingPartner);
    if (!updated) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }
    return this.getDetail(businessId);
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }
    return business;
  }

  private toListItemDto(
    business: BusinessDocument,
    bookingCounts: Map<string, number>,
  ): SuperAdminBusinessListItemDto {
    return {
      id: String(business._id),
      name: business.name,
      category: business.category,
      visitType: normalizeBusinessVisitType(business.visitType),
      city: business.address.city,
      status: business.status,
      rating: null,
      reviewsCount: null,
      bookingsCount: bookingCounts.get(String(business._id)) ?? 0,
      memberSince: business.createdAt.toISOString(),
    };
  }

  private toDetailDto(
    business: BusinessDocument,
    owner: UserDocument | null,
    bookingsCount: number,
    actorEmailById: Map<string, string>,
    ratingAggregate: ReviewAggregate,
    gapEliminationEnabled: boolean,
    bookingMode: SuperAdminBusinessBookingMode,
  ): SuperAdminBusinessDetailDto {
    return {
      id: String(business._id),
      name: business.name,
      ownerName: business.ownerName,
      status: business.status,
      visitType: normalizeBusinessVisitType(business.visitType),
      timezone: business.timezone,
      phone: business.phone,
      address: business.address,
      briefDescription: business.briefDescription,
      category: business.category,
      subcategories: business.subcategories,
      owner: owner
        ? {
            id: String(owner._id),
            email: owner.normalizedEmail,
            status: owner.status,
            lastLoginAt: owner.security.lastLoginAt
              ? owner.security.lastLoginAt.toISOString()
              : null,
          }
        : { id: String(business.ownerUserId), email: "", status: "UNKNOWN", lastLoginAt: null },
      rating: ratingAggregate.averageRating,
      reviewsCount: ratingAggregate.reviewCount,
      gapEliminationEnabled,
      bookingMode,
      isFoundingPartner: business.isFoundingPartner,
      bookingsCount,
      statusHistory: business.statusHistory
        .slice()
        .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
        .map((entry) => ({
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          actorUserId: String(entry.actorUserId),
          ...(actorEmailById.get(String(entry.actorUserId))
            ? { actorEmail: actorEmailById.get(String(entry.actorUserId)) as string }
            : {}),
          ...(entry.reason ? { reason: entry.reason } : {}),
          changedAt: entry.changedAt.toISOString(),
        })),
      createdAt: business.createdAt.toISOString(),
      updatedAt: business.updatedAt.toISOString(),
    };
  }
}
