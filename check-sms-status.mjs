import { readFileSync } from "node:fs";
import twilio from "twilio";

const envPath = new URL("./.env", import.meta.url);
const raw = readFileSync(envPath, "utf8");
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

const sid = process.argv[2];
if (!sid) {
  console.error("Usage: node check-sms-status.mjs SM...");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

try {
  const message = await client.messages(sid).fetch();
  console.log("SID:", message.sid);
  console.log("Status:", message.status);
  console.log("To:", message.to);
  console.log("From:", message.from);
  console.log("MessagingServiceSid:", message.messagingServiceSid);
  console.log("ErrorCode:", message.errorCode);
  console.log("ErrorMessage:", message.errorMessage);
  console.log("DateSent:", message.dateSent);
  console.log("DateUpdated:", message.dateUpdated);
  console.log("Price:", message.price, message.priceUnit);
} catch (error) {
  console.error("FAILED");
  console.error("Code:", error.code);
  console.error("Message:", error.message);
}
