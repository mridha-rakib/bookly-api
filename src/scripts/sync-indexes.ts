import { pathToFileURL } from "node:url";

import mongoose from "mongoose";

import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import "../modules/addons/addon-service-assignment.model.js";
import "../modules/addons/addon.model.js";
import "../modules/booking/booking-creation-claim.model.js";
import "../modules/booking/booking.model.js";
import "../modules/booking-financial-transaction/booking-financial-transaction.model.js";
import "../modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import "../modules/booking-slot-reservation/booking-slot-reservation.model.js";
import "../modules/business/business-access.model.js";
import "../modules/business/business-link-verification.model.js";
import "../modules/business/business.model.js";
import "../modules/business-booking-settings/business-booking-settings.model.js";
import "../modules/business-cancellation-policy/business-cancellation-policy.model.js";
import "../modules/business-hours/business-hours.model.js";
import "../modules/business-media/business-media.model.js";
import "../modules/business-travel-settings/business-travel-settings.model.js";
import "../modules/business-onboarding/business-onboarding.model.js";
import "../modules/client/client.model.js";
import "../modules/email-outbox/email-outbox.model.js";
import "../modules/linked-account/linked-account.model.js";
import "../modules/marketing/marketing-campaign.model.js";
import "../modules/marketing/marketing-campaign-recipient.model.js";
import "../modules/payment/customer-payment-profile.model.js";
import "../modules/registration-session/registration-session.model.js";
import "../modules/services/service-category.model.js";
import "../modules/services/service.model.js";
import "../modules/session/session.model.js";
import "../modules/staff/staff.model.js";
import "../modules/staff/staff-access-event.model.js";
import "../modules/staff/staff-schedule.model.js";
import "../modules/staff/staff-time-off.model.js";
import "../modules/staff-avatar/staff-avatar.model.js";
import "../modules/staff-invitation/staff-invitation.model.js";
import "../modules/stripe-webhook/stripe-webhook-event.model.js";
import "../modules/user/user.model.js";

type SyncIndexesLogger = Pick<typeof logger, "info" | "error">;

export type SyncIndexesResult = {
  modelName: string;
  createdOrDropped: string[];
};

/**
 * Deterministic, production-safe index provisioning.
 *
 * `autoIndex` is disabled in production (see DatabaseManager.connect), so index
 * creation/removal must be applied out-of-band via this script rather than
 * implicitly on server boot. Run it as an explicit deploy step, after reviewing
 * for duplicate-key conflicts on any newly-unique index (e.g. Business.ownerUserId,
 * BusinessAccess.{userId,businessId}, StaffMembership.userId (partial, active-only),
 * StaffSchedule.membershipId, BusinessOpeningHours.businessId, Booking.reference)
 * against the target database.
 *
 * The side-effect imports above previously omitted Addon, AddonServiceAssignment, Service,
 * ServiceCategory, StaffAvatar, and BusinessBookingSettings — those models existed and were
 * registered at runtime (so the app itself worked fine), but this script never synced their
 * indexes because `mongoose.modelNames()` only sees whatever has been imported into the
 * running process. Fixed alongside adding Booking/BusinessOpeningHours; if this script is ever
 * split out of the main process again, re-check this import list against
 * `src/modules/*.model.ts` rather than assuming it is complete.
 */
export const syncDatabaseIndexes = async (
  dependencies: { logger: SyncIndexesLogger } = { logger },
): Promise<SyncIndexesResult[]> => {
  const results: SyncIndexesResult[] = [];

  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName);
    const changes = await model.syncIndexes();
    results.push({ modelName, createdOrDropped: changes });
    dependencies.logger.info({ modelName, changes }, "Synced indexes for model");
  }

  return results;
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();

  try {
    await databaseManager.connect();
    await syncDatabaseIndexes({ logger });
    logger.info("Index sync completed");
  } catch (error) {
    logger.error({ err: error }, "Index sync failed");
    throw error;
  } finally {
    await databaseManager.disconnect();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
