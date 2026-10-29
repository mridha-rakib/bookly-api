import { describe, expect, it } from "vitest";

import {
  assertEmailWorkerLaunch,
  EmailWorkerLaunchError,
} from "../../src/scripts/email-worker-runtime.js";

/**
 * F4A — explicit activation boundary of the transactional email worker. Synthetic values only;
 * nothing here builds a transport, connects to a database or contacts a provider.
 */

const sendgridLaunch = {
  BOOKLY_EMAIL_WORKER_ENABLED: "true",
  MONGODB_URI: "mongodb://127.0.0.1:27017/synthetic_email_worker",
  EMAIL_PROVIDER: "sendgrid",
  SENDGRID_API_KEY: "synthetic-not-a-key",
  EMAIL_FROM: "noreply@example.test",
};

describe("email worker launch boundary", () => {
  it.each([{ args: [] }, { args: ["--once"] }])(
    "accepts an explicitly enabled, fully configured launch %j",
    ({ args }) => {
      expect(() => assertEmailWorkerLaunch(sendgridLaunch, args)).not.toThrow();
    },
  );

  it("is disabled by default: no enablement flag means no start", () => {
    const { BOOKLY_EMAIL_WORKER_ENABLED: _flag, ...withoutFlag } = sendgridLaunch;
    expect(() => assertEmailWorkerLaunch(withoutFlag, [])).toThrow(EmailWorkerLaunchError);
  });

  it.each([
    ["BOOKLY_EMAIL_WORKER_ENABLED", "false"],
    ["BOOKLY_EMAIL_WORKER_ENABLED", "1"],
    ["BOOKLY_EMAIL_WORKER_ENABLED", "TRUE"],
    ["MONGODB_URI", undefined],
    ["MONGODB_URI", " "],
    ["EMAIL_PROVIDER", undefined],
    ["EMAIL_PROVIDER", ""],
    ["EMAIL_PROVIDER", "console"],
    ["SENDGRID_API_KEY", undefined],
    ["SENDGRID_API_KEY", " "],
    ["EMAIL_FROM", undefined],
  ] as const)("refuses incomplete or unsupported launch: %s=%s", (key, value) => {
    expect(() => assertEmailWorkerLaunch({ ...sendgridLaunch, [key]: value }, [])).toThrow(
      EmailWorkerLaunchError,
    );
  });

  it("refuses a defaulted provider even when its credentials happen to be present", () => {
    const { EMAIL_PROVIDER: _provider, ...defaulted } = sendgridLaunch;
    expect(() => assertEmailWorkerLaunch(defaulted, [])).toThrow(/explicit supported/);
  });

  it("checks the requirements of the selected provider (resend, smtp)", () => {
    const base = {
      BOOKLY_EMAIL_WORKER_ENABLED: "true",
      MONGODB_URI: "mongodb://127.0.0.1:27017/synthetic_email_worker",
    };
    expect(() =>
      assertEmailWorkerLaunch(
        {
          ...base,
          EMAIL_PROVIDER: "resend",
          RESEND_API_KEY: "synthetic",
          RESEND_FROM_EMAIL: "noreply@example.test",
          RESEND_FROM_NAME: "Bookly",
        },
        [],
      ),
    ).not.toThrow();
    expect(() =>
      assertEmailWorkerLaunch({ ...base, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "x" }, []),
    ).toThrow(/RESEND_FROM_EMAIL/);
    expect(() =>
      assertEmailWorkerLaunch(
        { ...base, EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.test", EMAIL_FROM: "a@b.test" },
        [],
      ),
    ).toThrow(/SMTP_USER, SMTP_PASS/);
  });

  it("rejects misspelled or repeated CLI options instead of silently polling forever", () => {
    expect(() => assertEmailWorkerLaunch(sendgridLaunch, ["--ones"])).toThrow();
    expect(() => assertEmailWorkerLaunch(sendgridLaunch, ["--once", "--once"])).toThrow();
  });

  it("never echoes a supplied secret or connection value in a launch error", () => {
    const secretUri = "mongodb://user:private-password@db.example.test/x";
    let message = "";
    try {
      assertEmailWorkerLaunch(
        { ...sendgridLaunch, MONGODB_URI: secretUri, SENDGRID_API_KEY: " " },
        [],
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SENDGRID_API_KEY");
    expect(message).not.toContain("private-password");
    expect(message).not.toContain("synthetic-not-a-key");
  });

  it("does not claim a singleton: multi-consumer safety comes from the outbox claim, not here", () => {
    expect(() =>
      assertEmailWorkerLaunch({ ...sendgridLaunch, NODE_APP_INSTANCE: "3" }, []),
    ).not.toThrow();
  });
});
