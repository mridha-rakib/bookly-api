import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { normalizeEmail } from "../modules/auth/auth.utils.js";
import { Argon2PasswordHasher } from "../modules/auth/password-hasher.js";
import { UserRepository } from "../modules/user/user.repository.js";

const requiredValues = {
  SUPER_ADMIN_EMAIL: env.SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_PASSWORD: env.SUPER_ADMIN_PASSWORD,
  SUPER_ADMIN_FIRST_NAME: env.SUPER_ADMIN_FIRST_NAME,
  SUPER_ADMIN_LAST_NAME: env.SUPER_ADMIN_LAST_NAME,
};

const missing = Object.entries(requiredValues)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  throw new Error(`Missing required Super Admin seed environment values: ${missing.join(", ")}`);
}

const databaseManager = new DatabaseManager();
const userRepository = new UserRepository();
const passwordHasher = new Argon2PasswordHasher();

try {
  await databaseManager.connect();

  const normalizedEmail = normalizeEmail(requiredValues.SUPER_ADMIN_EMAIL ?? "");
  const existing = await userRepository.findByEmail(normalizedEmail);

  if (existing) {
    if (existing.role === "SUPER_ADMIN") {
      logger.info({ email: normalizedEmail }, "Super Admin already exists");
      process.exitCode = 0;
    } else {
      throw new Error("A non-Super Admin account already exists with this email");
    }
  } else {
    const passwordHash = await passwordHasher.hash(requiredValues.SUPER_ADMIN_PASSWORD ?? "");
    const user = await userRepository.create({
      normalizedEmail,
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: requiredValues.SUPER_ADMIN_FIRST_NAME ?? "",
      lastName: requiredValues.SUPER_ADMIN_LAST_NAME ?? "",
      gender: "other",
      phone: {
        countryCode: "+000",
        nationalNumber: "0000",
        e164: "+0000000",
      },
    });
    logger.info({ email: normalizedEmail }, "Super Admin created");
  }
} finally {
  await databaseManager.disconnect();
}
