import type { ClientSession } from "mongoose";
import { AddonModel } from "../addons/addon.model.js";
import { AddonServiceAssignmentModel } from "../addons/addon-service-assignment.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import { BusinessCancellationPolicyModel } from "../business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessTravelSettingsModel } from "../business-travel-settings/business-travel-settings.model.js";
import { resolveBusinessCategoryKey } from "../platform-settings/business-category.js";
import { defaultNoShowWindowFor } from "../platform-settings/platform-settings.constants.js";
import { PlatformSettingsModel } from "../platform-settings/platform-settings.model.js";
import { ServiceModel } from "../services/service.model.js";
import { batchConflict } from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { packageCheckoutQuoteSchema } from "./package-checkout-contract.js";

/** Caller already holds Business coordinator. Existing unfenced catalogue/settings writers
 * contend with real writes on the very dependency rows; a snapshot read alone is insufficient.
 * No timestamp/financial counter is repurposed. Existing Mongoose __v writes roll back. */
export async function validateBatchAcceptedDependencies(
  input: unknown,
  business: BusinessDocument,
  session: ClientSession,
) {
  if (!session.inTransaction()) throw batchConflict();
  const q = packageCheckoutQuoteSchema.parse(input);
  const versionRange = {
    $or: [{ __v: { $exists: false } }, { __v: { $gte: 0, $lt: Number.MAX_SAFE_INTEGER } }],
  };
  const policy = await BusinessCancellationPolicyModel.findOne({
    businessId: business._id,
  }).session(session);
  const policyFacts = policy
    ? {
        tiers: policy.tiers.map((t) => ({
          tier: t.tier,
          mode: t.mode,
          ...(t.percentage !== undefined ? { percentage: t.percentage } : {}),
        })),
        noShowPercentage: policy.noShowPercentage,
      }
    : null;
  if (digest(policyFacts) !== digest(q.policy.cancellation)) throw batchConflict();
  const category = business.categoryKey ?? resolveBusinessCategoryKey(business.category);
  if (category) {
    const settings = await PlatformSettingsModel.findOneAndUpdate(
      { key: "SINGLETON", ...versionRange },
      { $inc: { __v: 1 }, $setOnInsert: { key: "SINGLETON" } },
      {
        session,
        upsert: true,
        setDefaultsOnInsert: true,
        returnDocument: "after",
        timestamps: false,
      },
    ).orFail();
    const found = settings.noShowCategoryWindows.find((w) => w.categoryKey === category);
    const window = found
      ? {
          categoryKey: found.categoryKey,
          opensAfterMinutes: found.opensAfterMinutes,
          closesAfterMinutes: found.closesAfterMinutes,
        }
      : defaultNoShowWindowFor(category);
    if (digest(window) !== digest(q.policy.noShowWindow)) throw batchConflict();
  } else if (q.policy.noShowWindow) throw batchConflict();
  const travel =
    business.visitType === "TRAVEL_TO_CUSTOMER"
      ? await BusinessTravelSettingsModel.findOne({ businessId: business._id }).session(session)
      : null;
  for (const i of q.items) {
    if (business.visitType === "TRAVEL_TO_CUSTOMER") {
      const service = await ServiceModel.findById(i.serviceId).session(session).orFail();
      const current = (travel?.cities ?? [])
        .filter((c) => c.active && service.servedCities.includes(c.city))
        .map(({ city, feeCents }) => ({ city, feeCents }))
        .sort((a, b) => a.city.localeCompare(b.city));
      if (!i.travelEntitlement || digest(current) !== digest(i.travelEntitlement.cities))
        throw batchConflict();
    } else if (i.travelEntitlement) throw batchConflict();
  }
  for (const a of q.appointments) {
    if (a.location.mode !== business.visitType) throw batchConflict();
    const item = q.items.find((i) => i.packageItemId.equals(a.packageItemId));
    if (a.location.mode === "TRAVEL_TO_CUSTOMER") {
      const city = a.location.travelAddress.city;
      if (
        item?.travelEntitlement?.cities.find((c) => c.city === city)?.feeCents !== a.travelFeeCents
      )
        throw batchConflict();
    }
    for (const addon of a.addons) {
      const current = await AddonModel.findOneAndUpdate(
        {
          _id: addon.addonId,
          businessId: business._id,
          status: "ACTIVE",
          name: addon.name,
          priceCents: addon.priceCents,
          ...versionRange,
        },
        { $inc: { __v: 1 } },
        { session, returnDocument: "after", timestamps: false },
      );
      const assigned = await AddonServiceAssignmentModel.findOneAndUpdate(
        {
          addonId: addon.addonId,
          serviceId: a.serviceId,
          businessId: business._id,
          ...versionRange,
        },
        { $inc: { __v: 1 } },
        { session, returnDocument: "after", timestamps: false },
      );
      if (!current || !assigned) throw batchConflict();
    }
  }
}
