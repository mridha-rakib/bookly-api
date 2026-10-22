import { BusinessOpeningHoursModel } from "../../src/modules/business-hours/business-hours.model.js";
import { ServiceCategoryModel } from "../../src/modules/services/service-category.model.js";
import { StaffScheduleModel } from "../../src/modules/staff/staff-schedule.model.js";
import { daysOfWeek } from "../../src/modules/staff/staff-schedule.types.js";
import { UserProfileModel } from "../../src/modules/user/user.model.js";
import type { checkoutFixture } from "./package-checkout-fixture.js";

/** Validated real domain rows for actual availability and consent composition. */
export const seedConsentDomain = async (f: ReturnType<typeof checkoutFixture>) => {
  f.business.set({
    ownerName: "Synthetic Owner",
    email: "business@consent.test",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    briefDescription: "Disposable fixture",
  });
  await f.business.save();
  for (const member of f.providers) await member.save();
  for (const service of f.services) {
    service.set({ category: "Wellness & Beauty", sessionExpiryAlert: { enabled: false } });
    await service.save();
  }
  const category = await ServiceCategoryModel.create({
    businessId: f.business._id,
    name: "Hair",
    nameKey: "hair",
    active: true,
  });
  f.definition.set({
    category: "Wellness & Beauty",
    subcategory: "Hair",
    serviceCategoryId: category._id,
  });
  await f.definition.save();
  await f.configuredPolicy.save();
  for (const member of f.providers) {
    await UserProfileModel.create({
      userId: member.userId,
      firstName: "Synthetic",
      lastName: "Professional",
      gender: "other",
    });
    await StaffScheduleModel.create({
      membershipId: member._id,
      businessId: f.business._id,
      days: daysOfWeek.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "00:00", endTime: "23:59" }],
      })),
    });
  }
  await BusinessOpeningHoursModel.create({
    businessId: f.business._id,
    days: daysOfWeek.map((dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      slots: [{ startTime: "00:00", endTime: "23:59" }],
    })),
  });
};
