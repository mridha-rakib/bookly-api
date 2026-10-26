import { Schema, type Types } from "mongoose";
import {
  type PackageGroupSeat,
  packageGroupSeatMongooseSchema,
  readPackageGroupSeat,
} from "../packages/package-service-entitlement.js";

export type BookingPackageContext = {
  packageId: Types.ObjectId;
  packageName: string;
  definitionItemId: Types.ObjectId;
  role: "PURCHASE" | "REDEMPTION";
};
export type BookingSchedulingSnapshot = {
  group?: PackageGroupSeat | undefined;
  version: 1;
  baseDurationMin: number;
  bufferAfterMin: number;
  processingTimeMin: number;
  occupiedDurationMin: number;
};
const minute = {
  type: Number,
  required: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  validate: Number.isSafeInteger,
};
export const bookingPackageContextSchema = new Schema<BookingPackageContext>(
  {
    packageId: { type: Schema.Types.ObjectId, required: true },
    packageName: { type: String, required: true, trim: true },
    definitionItemId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ["PURCHASE", "REDEMPTION"], required: true },
  },
  { _id: false, strict: "throw" },
);
export const bookingSchedulingSnapshotSchema = new Schema<BookingSchedulingSnapshot>(
  {
    version: { type: Number, enum: [1], required: true },
    group: { type: packageGroupSeatMongooseSchema, required: false },
    baseDurationMin: { ...minute, min: 1 },
    bufferAfterMin: minute,
    processingTimeMin: minute,
    occupiedDurationMin: { ...minute, min: 1 },
  },
  { _id: false, strict: "throw" },
);

export const validPackageSchedulingSnapshot = (snapshot: BookingSchedulingSnapshot): boolean =>
  snapshot.version === 1 &&
  (snapshot.group === undefined ||
    (validGroup(snapshot.group) && snapshot.processingTimeMin === 0)) &&
  [
    snapshot.baseDurationMin,
    snapshot.bufferAfterMin,
    snapshot.processingTimeMin,
    snapshot.occupiedDurationMin,
  ].every(Number.isSafeInteger) &&
  snapshot.baseDurationMin >= 1 &&
  snapshot.bufferAfterMin >= 0 &&
  snapshot.processingTimeMin >= 0 &&
  BigInt(snapshot.occupiedDurationMin) ===
    BigInt(snapshot.baseDurationMin) +
      BigInt(snapshot.bufferAfterMin) +
      BigInt(snapshot.processingTimeMin);

/** One-seat Package occupancy is independent of ordinary personCount pricing. */
export function packageReservationPartySize(line: {
  serviceSnapshot: { pricingMode: string };
  pricingInput: {
    personCount?: number | undefined;
    packageItemId?: Types.ObjectId | undefined;
    packageProgressId?: Types.ObjectId | undefined;
  };
  schedulingSnapshot?: BookingSchedulingSnapshot | undefined;
  packageContext?: BookingPackageContext | undefined;
}): number {
  if (!line.schedulingSnapshot?.group) return line.pricingInput.personCount ?? 1;
  if (
    line.serviceSnapshot.pricingMode !== "PACKAGE" ||
    !line.packageContext ||
    !line.pricingInput.packageItemId ||
    !line.pricingInput.packageProgressId ||
    line.pricingInput.personCount !== undefined ||
    !validPackageSchedulingSnapshot(line.schedulingSnapshot)
  )
    throw new Error("Invalid one-seat Package reservation contract");
  return readPackageGroupSeat(line.schedulingSnapshot.group).partySize;
}

function validGroup(group: PackageGroupSeat): boolean {
  try {
    readPackageGroupSeat(group);
    return true;
  } catch {
    return false;
  }
}
