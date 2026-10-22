import type { Types } from "mongoose";
import type { BusinessCity, BusinessVisitType } from "../business/business.types.js";
import type {
  PackageProgressDocument,
  PackageProgressSessionStatus,
} from "./package-progress.model.js";
import type { PurchasedPackageContractFragments } from "./purchased-package-contract.js";

export type PurchasedPackageItem = {
  packageItemId: Types.ObjectId;
  definitionItemId: Types.ObjectId;
  serviceId: Types.ObjectId;
  serviceSnapshot: { name: string; pricingMode: "FIXED"; durationMin: number };
  totalSessions: number;
  remainingSessions: number;
  completedSessions: number;
  referenceUnitPriceCents: number;
  travelCities?: Array<{ city: BusinessCity; feeCents: number }> | undefined;
};
export type PurchasedPackageAttempt = {
  bookingId: Types.ObjectId;
  packageItemId: Types.ObjectId;
  serviceId: Types.ObjectId;
  sessionIndex?: number | undefined;
  status: PackageProgressSessionStatus;
  resolution?:
    | {
        eventKey: string;
        resolvedAt: Date;
        outcome: "COMPLETED" | "CANCELLED" | "FORFEITED";
        restorationDisposition?: "AVAILABLE" | "EXPIRED" | undefined;
      }
    | undefined;
};
export type PackageExpiryEvent = {
  eventKey: string;
  packageProgressId: Types.ObjectId;
  packageItemId: Types.ObjectId;
  cutoff: Date;
  quantity: number;
  reason: "VALIDITY_EXPIRED";
  processedAt: Date;
};
export type ProspectivePurchasedItem = PurchasedPackageItem & {
  penaltyBasisCents: number;
  expiredSessions: number;
  expiryEvent?: PackageExpiryEvent | undefined;
};
type PackageProgressV2Base = {
  _id: Types.ObjectId;
  schemaVersion: 2;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  packageId: Types.ObjectId;
  originBookingId: Types.ObjectId;
  purchaseSnapshot: {
    name: string;
    packageRevision: number;
    bundlePriceCents: number;
    referenceTotalCents: number;
    discountPercent: number;
    currency: "EUR";
    fulfilmentMode: BusinessVisitType;
  };
  sessions: PurchasedPackageAttempt[];
  voidedAt?: Date | undefined;
  voidRefundSettlement?: PackageProgressDocument["voidRefundSettlement"];
  createdAt: Date;
  updatedAt: Date;
};
export type HistoricalPackageProgressV2Document = PackageProgressV2Base & {
  creditAccountingVersion?: 1 | undefined;
  items: PurchasedPackageItem[];
  purchasedContract?: never;
  expiryReconciledAt?: never;
};
export type ProspectivePackageProgressV2Document = PackageProgressV2Base & {
  creditAccountingVersion: 2;
  /** P is canonical on items; the header deliberately does not store a second item copy. */
  purchasedContract: Omit<PurchasedPackageContractFragments, "items">;
  items: ProspectivePurchasedItem[];
  expiryReconciledAt?: Date | undefined;
};
export type PackageProgressV2Document =
  | HistoricalPackageProgressV2Document
  | ProspectivePackageProgressV2Document;
export type CreatePackageProgressV2Input =
  | Omit<HistoricalPackageProgressV2Document, "createdAt" | "updatedAt">
  | Omit<ProspectivePackageProgressV2Document, "createdAt" | "updatedAt">;
export type PackageItemScope = {
  packageProgressId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  packageItemId: Types.ObjectId;
  serviceId: Types.ObjectId;
};
export type VersionedPackageProgress =
  | (PackageProgressDocument & { schemaVersion?: 1 })
  | PackageProgressV2Document;
