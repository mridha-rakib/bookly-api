import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import { ClientCreatedNotifier } from "../../src/modules/notification/client-created.notifier.js";

/** MAILING STAGE B — Trigger 1 notifier (Part T items 1–6). */

const makeOutbox = () => {
  const enqueue = vi.fn().mockResolvedValue({ created: true, record: {} });
  return { enqueue: enqueue as unknown as EmailOutboxService["enqueue"], spy: enqueue };
};

const input = {
  clientId: "6512aa000000000000000001",
  clientFirstName: "Dana",
  clientEmail: "Dana@Example.com",
  businessName: "Soho Vintage Barbers",
};

describe("ClientCreatedNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1/2/3 enqueues CLIENT_CREATED to the client with a deterministic event key", async () => {
    const outbox = makeOutbox();
    await new ClientCreatedNotifier(outbox as unknown as EmailOutboxService).notifyClientCreated(
      input,
    );

    expect(outbox.spy).toHaveBeenCalledTimes(1);
    expect(outbox.spy).toHaveBeenCalledWith({
      eventKey: "CLIENT_CREATED:6512aa000000000000000001",
      templateKey: "CLIENT_CREATED",
      recipient: "dana@example.com",
      payload: { clientFirstName: "Dana", businessName: "Soho Vintage Barbers" },
    });
  });

  it("4 payload carries no account/login fields", async () => {
    const outbox = makeOutbox();
    await new ClientCreatedNotifier(outbox as unknown as EmailOutboxService).notifyClientCreated(
      input,
    );
    const payload = outbox.spy.mock.calls[0]?.[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(["businessName", "clientFirstName"]);
  });

  it("6 a blank/unusable recipient is skipped without throwing", async () => {
    const outbox = makeOutbox();
    await expect(
      new ClientCreatedNotifier(outbox as unknown as EmailOutboxService).notifyClientCreated({
        ...input,
        clientEmail: "   ",
      }),
    ).resolves.toBeUndefined();
    expect(outbox.spy).not.toHaveBeenCalled();
  });

  it("6 an outbox error is swallowed (client creation must not fail)", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("mongo down"));
    await expect(
      new ClientCreatedNotifier({ enqueue } as unknown as EmailOutboxService).notifyClientCreated(
        input,
      ),
    ).resolves.toBeUndefined();
  });
});
