import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { normalizeEmail, normalizePhoneNumber } from "../modules/auth/auth.utils.js";
import { Argon2PasswordHasher, type PasswordHasher } from "../modules/auth/password-hasher.js";
import { UserRepository } from "../modules/user/user.repository.js";

/**
 * LOCAL-DEVELOPMENT-ONLY demo CUSTOMER seed.
 *
 * Mirrors seed-super-admin.ts exactly (same idempotency contract, same env-driven config, same
 * hashing path) — it just produces a CUSTOMER instead of a SUPER_ADMIN so a developer can log in
 * through the REAL customer login flow (`POST /auth/customer/login`, i.e. the `/customer` UI) and
 * exercise the authenticated booking journey without hand-running the multi-step OTP registration.
 *
 * Not wired into app bootstrap and never imported by the server — it is a manual `tsx` CLI only
 * (`pnpm seed:demo-customer`). It additionally hard-refuses to run when `NODE_ENV=production`.
 *
 * The account is created already-verified on both signals (`emailVerifiedAt` + `phoneVerifiedAt`),
 * matching what `completeCustomer` produces at the end of the normal flow — so every downstream
 * invariant that assumes "every CUSTOMER row is OTP-verified" (client-identity linking, etc.)
 * still holds.
 */

/** A non-routable placeholder phone for the local demo account. It is only ever stored on the
 * seeded UserProfile so identity/linking code has a well-formed value to read; the demo account
 * is created pre-verified and never triggers a real OTP send. Not user-facing content. */
const DEMO_CUSTOMER_PHONE = { countryCode: "+357", nationalNumber: "99000000" } as const;

type DemoCustomerSeedConfig = {
  email?: string | undefined;
  password?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

type DemoCustomerSeedLogger = Pick<typeof logger, "info">;

export type DemoCustomerSeedResult = "created" | "already_exists";

export const seedDemoCustomer = async (
  config: DemoCustomerSeedConfig,
  dependencies: {
    userRepository: UserRepository;
    passwordHasher: PasswordHasher;
    logger: DemoCustomerSeedLogger;
    /** Injectable for tests; defaults to the real process env. */
    nodeEnv?: string;
  },
): Promise<DemoCustomerSeedResult> => {
  const nodeEnv = dependencies.nodeEnv ?? env.NODE_ENV;
  if (nodeEnv === "production") {
    throw new Error("seedDemoCustomer must never run in production");
  }

  const requiredValues = {
    DEMO_CUSTOMER_EMAIL: config.email,
    DEMO_CUSTOMER_PASSWORD: config.password,
  };
  const missing = Object.entries(requiredValues)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Demo Customer seed environment values: ${missing.join(", ")}`,
    );
  }

  const firstName = config.firstName ?? "Demo";
  const lastName = config.lastName ?? "Customer";
  const normalizedEmail = normalizeEmail(config.email ?? "");
  const phone = normalizePhoneNumber(
    DEMO_CUSTOMER_PHONE.countryCode,
    DEMO_CUSTOMER_PHONE.nationalNumber,
  );

  const existing = await dependencies.userRepository.findByEmail(normalizedEmail);
  if (existing) {
    if (existing.role !== "CUSTOMER") {
      throw new Error("A non-Customer account already exists with this email");
    }

    // Idempotent recovery: a prior half-completed run (user row created, profile creation
    // failed) must converge to a usable account rather than staying broken forever.
    const profile = await dependencies.userRepository.findProfileByUserId(existing._id);
    if (!profile) {
      await dependencies.userRepository.createProfile({
        userId: existing._id,
        firstName,
        lastName,
        gender: "other",
        phone,
        termsAcceptedAt: new Date(),
      });
    }
    dependencies.logger.info({ email: normalizedEmail }, "Demo customer already exists");
    return "already_exists";
  }

  const passwordHash = await dependencies.passwordHasher.hash(config.password ?? "");
  const user = await dependencies.userRepository.create({
    normalizedEmail,
    passwordHash,
    authProviders: ["PASSWORD"],
    role: "CUSTOMER",
    status: "ACTIVE",
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
  });
  await dependencies.userRepository.createProfile({
    userId: user._id,
    firstName,
    lastName,
    gender: "other",
    phone,
    termsAcceptedAt: new Date(),
  });
  dependencies.logger.info({ email: normalizedEmail }, "Demo customer created");
  return "created";
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();

  try {
    await databaseManager.connect();
    await seedDemoCustomer(
      {
        email: env.DEMO_CUSTOMER_EMAIL,
        password: env.DEMO_CUSTOMER_PASSWORD,
        firstName: env.DEMO_CUSTOMER_FIRST_NAME,
        lastName: env.DEMO_CUSTOMER_LAST_NAME,
      },
      {
        userRepository: new UserRepository(),
        passwordHasher: new Argon2PasswordHasher(),
        logger,
      },
    );
  } finally {
    await databaseManager.disconnect();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
