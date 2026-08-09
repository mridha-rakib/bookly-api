import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { normalizeEmail } from "../modules/auth/auth.utils.js";
import { Argon2PasswordHasher, type PasswordHasher } from "../modules/auth/password-hasher.js";
import { UserRepository } from "../modules/user/user.repository.js";

type SuperAdminSeedConfig = {
  email?: string | undefined;
  password?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

type SuperAdminSeedLogger = Pick<typeof logger, "info">;

export type SuperAdminSeedResult = "created" | "already_exists";

export const seedSuperAdmin = async (
  config: SuperAdminSeedConfig,
  dependencies: {
    userRepository: UserRepository;
    passwordHasher: PasswordHasher;
    logger: SuperAdminSeedLogger;
  },
): Promise<SuperAdminSeedResult> => {
  const requiredValues = {
    SUPER_ADMIN_EMAIL: config.email,
    SUPER_ADMIN_PASSWORD: config.password,
    SUPER_ADMIN_FIRST_NAME: config.firstName,
    SUPER_ADMIN_LAST_NAME: config.lastName,
  };

  const missing = Object.entries(requiredValues)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required Super Admin seed environment values: ${missing.join(", ")}`);
  }

  const normalizedEmail = normalizeEmail(config.email ?? "");
  const existing = await dependencies.userRepository.findByEmail(normalizedEmail);

  if (existing) {
    if (existing.role === "SUPER_ADMIN") {
      dependencies.logger.info({ email: normalizedEmail }, "Super Admin already exists");
      return "already_exists";
    }

    throw new Error("A non-Super Admin account already exists with this email");
  }

  const passwordHash = await dependencies.passwordHasher.hash(config.password ?? "");
  const user = await dependencies.userRepository.create({
    normalizedEmail,
    passwordHash,
    role: "SUPER_ADMIN",
    status: "ACTIVE",
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
  });
  await dependencies.userRepository.createProfile({
    userId: user._id,
    firstName: config.firstName ?? "",
    lastName: config.lastName ?? "",
    gender: "other",
  });
  dependencies.logger.info({ email: normalizedEmail }, "Super Admin created");
  return "created";
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();

  try {
    await databaseManager.connect();
    await seedSuperAdmin(
      {
        email: env.SUPER_ADMIN_EMAIL,
        password: env.SUPER_ADMIN_PASSWORD,
        firstName: env.SUPER_ADMIN_FIRST_NAME,
        lastName: env.SUPER_ADMIN_LAST_NAME,
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
