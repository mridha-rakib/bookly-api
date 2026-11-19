// Developer diagnostic: look up one Twilio message's delivery status by SID.
//   node check-sms-status.mjs SM...
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from ./.env next to this file. Credentials are
// never printed. Exits non-zero on bad usage, missing credentials or a failed lookup.
import { readFileSync } from "node:fs";
import twilio from "twilio";

const formatValue = (value) => (value instanceof Date ? value.toISOString() : String(value));
const writeLine = (stream, label, ...values) => {
  stream.write(`${[label, ...values.map(formatValue)].join(" ")}\n`);
};
const out = (label, ...values) => writeLine(process.stdout, label, ...values);
const err = (label, ...values) => writeLine(process.stderr, label, ...values);

const sid = process.argv[2];
if (!sid) {
  err("Usage: node check-sms-status.mjs SM...");
  process.exit(1);
}

const envPath = new URL("./.env", import.meta.url);
let raw;
try {
  raw = readFileSync(envPath, "utf8");
} catch {
  err("FAILED");
  err("Message:", "could not read .env next to check-sms-status.mjs");
  process.exit(1);
}
const env = {};
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx === -1) continue;
  env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
}

const accountSid = env.TWILIO_ACCOUNT_SID;
const authToken = env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) {
  err("FAILED");
  err("Message:", "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

try {
  const message = await client.messages(sid).fetch();
  out("SID:", message.sid);
  out("Status:", message.status);
  out("To:", message.to);
  out("From:", message.from);
  out("MessagingServiceSid:", message.messagingServiceSid);
  out("ErrorCode:", message.errorCode);
  out("ErrorMessage:", message.errorMessage);
  out("DateSent:", message.dateSent);
  out("DateUpdated:", message.dateUpdated);
  out("Price:", message.price, message.priceUnit);
} catch (error) {
  err("FAILED");
  err("Code:", error?.code);
  err("Message:", error?.message);
  process.exitCode = 1;
}
