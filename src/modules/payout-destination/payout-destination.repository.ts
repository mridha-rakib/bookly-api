import type { ClientSession, Types } from "mongoose";

import {
  PAYOUT_DESTINATION_SECRET_SELECT,
  type PayoutDestinationDocument,
  PayoutDestinationModel,
} from "./payout-destination.model.js";
import type { PayoutDestinationHistoryEntry } from "./payout-destination.types.js";

export type UpsertPayoutDestinationInput = {
  accountHolderName: string;
  ibanCiphertext: string;
  ibanIv: string;
  ibanAuthTag: string;
  ibanKeyVersion: number;
  ibanLast4: string;
  ibanCountry: string;
  bankName?: string | undefined;
  lastUpdatedByUserId: Types.ObjectId;
};

/**
 * Data access for the one-per-Business payout destination.
 *
 * INVARIANT enforced by this class: no method here returns the encrypted IBAN fields EXCEPT
 * {@link findByBusinessIdWithSecret}, which exists solely for the Super Admin reveal path and is
 * named to make that obvious at every call site. Every other read relies on the schema's
 * `select: false` on `ibanCiphertext`/`ibanIv`/`ibanAuthTag`, so those fields are simply absent
 * from the returned documents — a masked read cannot leak them even by accident.
 */
export class PayoutDestinationRepository {
  /** Masked/metadata read. The ciphertext/iv/authTag are NOT selected (schema `select: false`). */
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<PayoutDestinationDocument | null> {
    const query = PayoutDestinationModel.findOne({ businessId });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  /**
   * The ONE decrypt-requesting read. Used only by PayoutDestinationService.revealIban (Super
   * Admin, rate-limited, audited). Never call this from a masked/list path.
   */
  public async findByBusinessIdWithSecret(
    businessId: Types.ObjectId | string,
  ): Promise<PayoutDestinationDocument | null> {
    return PayoutDestinationModel.findOne({ businessId })
      .select(PAYOUT_DESTINATION_SECRET_SELECT)
      .exec();
  }

  /**
   * Create-or-replace in ONE atomic upsert, with the history entry pushed in the same write —
   * the unique index on `businessId` makes "create a second destination" impossible, so a
   * concurrent double-submit resolves to an update rather than a duplicate row, and a record can
   * never end up with a new IBAN but no corresponding history entry.
   */
  public async upsert(
    businessId: Types.ObjectId,
    input: UpsertPayoutDestinationInput,
    historyEntry: PayoutDestinationHistoryEntry,
  ): Promise<PayoutDestinationDocument> {
    // `bankName` is optional and this is a create-or-REPLACE: an omitted bankName must CLEAR a
    // previously stored one rather than silently retaining it. `$set` and `$unset` may never name
    // the same path in one update (Mongo rejects it as a conflict), so the field goes in exactly
    // one of the two.
    const { bankName, ...alwaysSet } = input;
    const document = await PayoutDestinationModel.findOneAndUpdate(
      { businessId },
      {
        $set: bankName === undefined ? alwaysSet : { ...alwaysSet, bankName },
        ...(bankName === undefined ? { $unset: { bankName: "" } } : {}),
        $push: { history: historyEntry },
        $setOnInsert: { businessId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    if (!document) {
      throw new Error("PayoutDestination upsert returned no document");
    }

    return document;
  }

  /** Appends an audit entry without touching any destination field — used by the reveal path. */
  public async appendHistory(
    businessId: Types.ObjectId | string,
    historyEntry: PayoutDestinationHistoryEntry,
  ): Promise<void> {
    await PayoutDestinationModel.updateOne(
      { businessId },
      { $push: { history: historyEntry } },
    ).exec();
  }
}
