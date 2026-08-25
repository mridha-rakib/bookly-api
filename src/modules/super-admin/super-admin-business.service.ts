import type { BookingRepository } from "../booking/booking.repository.js";
import { BusinessError } from "../business/business.errors.js";
import type { BusinessAddress, BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessStatus, BusinessVisitType } from "../business/business.types.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessLifecycleService } from "../business/business-lifecycle.service.js";
import type { UserDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";

export type SuperAdminBusinessListItemDto = {
  id: string;
  name: string;
  category: string;
  visitType: BusinessVisitType;
  city: string;
  status: BusinessStatus;
  /** No review/rating system exists anywhere in this codebase (confirmed by investigation) —
   * always null, never fabricated. */
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
  owner: { id: string; email: string; status: string };
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
    const [owner, bookingCounts, actors] = await Promise.all([
      this.userRepository.findById(business.ownerUserId),
      this.bookingRepository.countByBusinessIds([business._id]),
      this.userRepository.findManyByIds(actorIds),
    ]);
    const actorEmailById = new Map(
      actors.map((actor) => [String(actor._id), actor.normalizedEmail]),
    );

    return this.toDetailDto(
      business,
      owner,
      bookingCounts.get(String(business._id)) ?? 0,
      actorEmailById,
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
        ? { id: String(owner._id), email: owner.normalizedEmail, status: owner.status }
        : { id: String(business.ownerUserId), email: "", status: "UNKNOWN" },
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
