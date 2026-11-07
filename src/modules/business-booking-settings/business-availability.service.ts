import { type ClientSession, Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { addCalendarDays, businessLocalToUtc } from "../../common/time/business-clock.js";
import { BookingModel } from "../booking/booking.model.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessRepository } from "../business/business.repository.js";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import type { UserRole } from "../user/user.types.js";
import {
  type AvailabilityRulesBody,
  type ChangeBlocksBody,
  changeSlotBlocks,
  resolveLocalBlock,
  type SlotBlock,
} from "./business-availability.rules.js";
import { BusinessBookingSettingsModel } from "./business-booking-settings.model.js";
import { BusinessBookingSettingsRepository } from "./business-booking-settings.repository.js";

const denied = () => new AppError("Business not found", 404, { expose: true });
export class BusinessAvailabilityService {
  constructor(
    private readonly businesses = new BusinessRepository(),
    private readonly settings = new BusinessBookingSettingsRepository(),
  ) {}

  private async requireAccess(
    userId: string,
    role: UserRole,
    businessId: string,
    ownerOnly: boolean,
    session?: ClientSession,
  ) {
    if (!Types.ObjectId.isValid(businessId)) throw denied();
    const business = await this.businesses.findById(businessId, session);
    if (!business) throw denied();
    if (role === "BUSINESS_OWNER" && business.ownerUserId.equals(userId)) return business;
    if (!ownerOnly && role === "SUPERVISOR") {
      const member = await StaffMembershipModel.findOne({
        userId,
        businessId,
        role: "SUPERVISOR",
        employmentActive: true,
        removedAt: null,
      })
        .session(session ?? null)
        .exec();
      if (member) return business;
    }
    throw denied();
  }

  async getRules(userId: string, role: UserRole, businessId: string) {
    const business = await this.requireAccess(userId, role, businessId, true);
    const saved = await this.settings.findByBusinessId(businessId);
    return {
      businessId,
      timezone: business.timezone,
      publicVisible: business.publicVisible !== false,
      minimumNoticeMinutes: saved?.availability?.minimumNoticeMinutes ?? null,
      maximumAdvanceMonths: saved?.availability?.maximumAdvanceMonths ?? null,
      closedPeriods: saved?.availability?.closedPeriods ?? [],
    };
  }

  async updateRules(
    userId: string,
    role: UserRole,
    businessId: string,
    body: AvailabilityRulesBody & { publicVisible: boolean },
  ) {
    await this.requireAccess(userId, role, businessId, true);
    const warning = await withPackageEligibility(businessId, undefined, async (session) => {
      const business = await this.requireAccess(userId, role, businessId, true, session);
      if (!["APPROVED", "WARNING"].includes(business.status))
        throw new AppError("Business is not approved for settings changes", 403, { expose: true });
      await BusinessBookingSettingsModel.findOneAndUpdate(
        { businessId },
        {
          $set: {
            "availability.minimumNoticeMinutes": body.minimumNoticeMinutes,
            "availability.maximumAdvanceMonths": body.maximumAdvanceMonths,
            "availability.closedPeriods": body.closedPeriods,
          },
        },
        { session, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      ).exec();
      await BusinessModel.updateOne(
        { _id: businessId, ownerUserId: userId },
        { $set: { publicVisible: body.publicVisible } },
        { session },
      ).exec();
      return this.countConflicts(
        businessId,
        body.closedPeriods.map((period) => ({
          startAt: businessLocalToUtc(business.timezone, period.startDate, "00:00"),
          endAt: businessLocalToUtc(business.timezone, addCalendarDays(period.endDate, 1), "00:00"),
        })),
        session,
      );
    });
    return { ...(await this.getRules(userId, role, businessId)), overlappingBookings: warning };
  }

  async getBlocks(userId: string, role: UserRole, businessId: string) {
    const business = await this.requireAccess(userId, role, businessId, false);
    const saved = await this.settings.findByBusinessId(businessId);
    return {
      businessId,
      timezone: business.timezone,
      blocks: saved?.availability?.slotBlocks ?? [],
      closedPeriods: saved?.availability?.closedPeriods ?? [],
    };
  }

  async changeBlocks(userId: string, role: UserRole, businessId: string, body: ChangeBlocksBody) {
    await this.requireAccess(userId, role, businessId, false);
    const result = await withPackageEligibility(businessId, undefined, async (session) => {
      const business = await this.requireAccess(userId, role, businessId, false, session);
      if (!["APPROVED", "WARNING"].includes(business.status))
        throw new AppError("Business is not approved for calendar changes", 403, { expose: true });
      let intervals: SlotBlock[];
      try {
        intervals = body.intervals.map((input) => resolveLocalBlock(input, business.timezone));
      } catch {
        throw new AppError("Invalid time range in Business timezone", 400, { expose: true });
      }
      const staffIds = [
        ...new Set(
          intervals.flatMap((interval) =>
            interval.staffMembershipId ? [interval.staffMembershipId] : [],
          ),
        ),
      ];
      if (staffIds.length) {
        // Removed members may have persisted blocks that the Business must still be able to reopen.
        const members = await StaffMembershipModel.find({ _id: { $in: staffIds }, businessId })
          .session(session)
          .exec();
        if (members.length !== staffIds.length) throw denied();
      }
      const saved = await this.settings.findByBusinessId(businessId, session);
      const blocks = changeSlotBlocks(
        saved?.availability?.slotBlocks ?? [],
        intervals,
        body.action,
      );
      if (blocks.length > 5000)
        throw new AppError("Too many calendar blocks; reopen unused ranges first", 409, {
          expose: true,
        });
      await BusinessBookingSettingsModel.findOneAndUpdate(
        { businessId },
        { $set: { "availability.slotBlocks": blocks } },
        { session, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      ).exec();
      return {
        blocks,
        overlappingBookings:
          body.action === "BLOCK" ? await this.countConflicts(businessId, intervals, session) : 0,
      };
    });
    return { businessId, ...result };
  }

  private async countConflicts(businessId: string, intervals: SlotBlock[], session: ClientSession) {
    if (!intervals.length) return 0;
    return BookingModel.countDocuments({
      businessId,
      status: { $in: ["UPCOMING", "PENDING"] },
      $or: intervals.map((interval) => ({
        "schedule.startAt": { $lt: interval.endAt },
        "schedule.endAt": { $gt: interval.startAt },
        ...(interval.staffMembershipId
          ? { "serviceLines.responsibleStaffMembershipId": interval.staffMembershipId }
          : {}),
      })),
    })
      .session(session)
      .exec();
  }
}
