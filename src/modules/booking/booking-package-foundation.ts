import { Schema, type Types } from "mongoose";

export type BookingPackageContext = {
  packageId: Types.ObjectId;
  packageName: string;
  definitionItemId: Types.ObjectId;
  role: "PURCHASE" | "REDEMPTION";
};
export type BookingSchedulingSnapshot = {
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
    baseDurationMin: { ...minute, min: 1 },
    bufferAfterMin: minute,
    processingTimeMin: minute,
    occupiedDurationMin: { ...minute, min: 1 },
  },
  { _id: false, strict: "throw" },
);

export const validPackageSchedulingSnapshot = (snapshot: BookingSchedulingSnapshot): boolean =>
  snapshot.version === 1 &&
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
