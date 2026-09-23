import type { Types } from "mongoose";

/**
 * What happened to a payout destination, recorded on the record's own embedded `history` array
 * (same shape/convention as `Business.statusHistory`). `IBAN_REVEALED` is a READ event — the one
 * read in this module that returns a decrypted IBAN (Super Admin reveal) is audited exactly like
 * a write, and like every other entry it stores only the last 4 digits, never the IBAN.
 */
export const payoutDestinationHistoryActions = ["CREATED", "UPDATED", "IBAN_REVEALED"] as const;
export type PayoutDestinationHistoryAction = (typeof payoutDestinationHistoryActions)[number];

export type PayoutDestinationHistoryEntry = {
  action: PayoutDestinationHistoryAction;
  actorUserId: Types.ObjectId;
  changedAt: Date;
  previousLast4?: string | undefined;
  newLast4?: string | undefined;
};

/**
 * The ONLY shape a payout destination is ever returned in outside the single, explicitly
 * decrypt-requesting reveal path. There is deliberately no `iban`, no `ibanCiphertext`, no
 * `ibanIv`, no `ibanAuthTag` and no `ibanKeyVersion` field here — a caller cannot leak what the
 * type does not carry.
 *
 * `configured` is derived purely from document existence (rule: absence = NOT_CONFIGURED,
 * presence = CONFIGURED). There is no VERIFIED/APPROVED/PENDING state anywhere in this module.
 */
export type PayoutDestinationView =
  | { configured: false }
  | {
      configured: true;
      accountHolderName: string;
      /** Country code + bullets + last 4, e.g. `"CY••••••••1234"`. Never the real IBAN. */
      ibanMasked: string;
      ibanLast4: string;
      ibanCountry: string;
      bankName?: string | undefined;
      updatedAt: Date;
    };

/** The Super Admin reveal result — the one place a decrypted IBAN crosses a module boundary. */
export type PayoutDestinationRevealView = {
  iban: string;
  accountHolderName: string;
  bankName?: string | undefined;
  revealedAt: Date;
};

/** The safe, non-reversible subset snapshotted onto a BusinessPayout at confirm time. */
export type PayoutDestinationSnapshot = {
  destinationId: Types.ObjectId;
  destinationLast4: string;
  destinationCountry: string;
  destinationAccountHolderName: string;
  destinationBankName?: string | undefined;
};

const MASK_BULLETS = "••••••••";

/** `"CY17002001280000001200527600"` → `"CY••••••••7600"`. Pure, no secret retained. */
export const buildMaskedIban = (ibanCountry: string, ibanLast4: string): string =>
  `${ibanCountry}${MASK_BULLETS}${ibanLast4}`;
