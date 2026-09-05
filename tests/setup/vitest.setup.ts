process.env["NODE_ENV"] = "test";
process.env["APP_NAME"] = "Bookly API";
process.env["API_VERSION"] = "v1";
process.env["LOG_LEVEL"] = "silent";
process.env["CORS_ORIGINS"] = "http://localhost:3000";
process.env["RATE_LIMIT_WINDOW_MS"] = "900000";
process.env["RATE_LIMIT_MAX"] = "1000";
process.env["API_DOCS_ENABLED"] = "true";
process.env["TRUST_PROXY"] = "false";
process.env["SHUTDOWN_TIMEOUT_MS"] = "1000";
process.env["EMAIL_PROVIDER"] = "smtp";
process.env["EMAIL_FROM"] = "noreply@example.com";
// Marketing M3B — configured by default so the campaign worker's one-click guard passes; the
// envelope/one-click tests delete it + re-import to cover the unconfigured path.
process.env["PUBLIC_API_BASE_URL"] = "https://api.test.local/api/v1";
process.env["EMAIL_FROM_NAME"] = "Bookly";
process.env["SMTP_HOST"] = "smtp.example.com";
process.env["SMTP_PORT"] = "587";
process.env["SMTP_SECURE"] = "false";
process.env["SMTP_USER"] = "smtp-user";
process.env["SMTP_PASS"] = "smtp-pass";
process.env["OTP_PROVIDER"] = "dummy";
process.env["DUMMY_PHONE_OTP_CODE"] = "123456";
process.env["ARGON2_MEMORY_COST"] = "8192";
process.env["ARGON2_TIME_COST"] = "1";
process.env["ARGON2_PARALLELISM"] = "1";
