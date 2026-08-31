import type { SmsTransport } from "./sms-transport.js";
import { TwilioSmsTransport } from "./twilio-sms-transport.js";

/**
 * The one active SMS transport. Only Twilio Messaging is implemented; this factory exists so the
 * SmsOutbox worker and its bootstrap depend on `createSmsTransport()` rather than `new
 * TwilioSmsTransport()` directly (mirrors `createEmailTransport`). Construction is cheap and
 * never validates credentials — `TwilioSmsTransport.send` raises `SmsError("NOT_CONFIGURED")`
 * at the moment a send is attempted without config, so an environment that doesn't run the SMS
 * worker is unaffected.
 */
export const createSmsTransport = (): SmsTransport => new TwilioSmsTransport();
