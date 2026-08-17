import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { ClientIdentityService } from "../../src/modules/client/client-identity.service.js";

const customer = (id: Types.ObjectId) => ({ _id: id });

const client = (id: Types.ObjectId) => ({ _id: id });

describe("ClientIdentityService.resolveContactLinkState", () => {
  it("links when email and phone resolve to the SAME verified Customer", async () => {
    const userId = new Types.ObjectId();
    const userRepository = {
      findVerifiedCustomerByEmail: vi.fn().mockResolvedValue(customer(userId)),
      findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue(customer(userId)),
    };
    const service = new ClientIdentityService(userRepository as never, {} as never);

    const result = await service.resolveContactLinkState({
      normalizedEmail: "maria@example.com",
      phoneE164: "+35799123456",
    });

    expect(result).toEqual({ linkState: "LINKED", linkedUserId: userId });
  });

  it("does not link when email matches but phone does not match anyone", async () => {
    const userId = new Types.ObjectId();
    const userRepository = {
      findVerifiedCustomerByEmail: vi.fn().mockResolvedValue(customer(userId)),
      findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue(null),
    };
    const service = new ClientIdentityService(userRepository as never, {} as never);

    const result = await service.resolveContactLinkState({
      normalizedEmail: "maria@example.com",
      phoneE164: "+35799999999",
    });

    expect(result).toEqual({ linkState: "IDENTITY_CONFLICT" });
  });

  it("does not link when phone matches but email does not match anyone", async () => {
    const userId = new Types.ObjectId();
    const userRepository = {
      findVerifiedCustomerByEmail: vi.fn().mockResolvedValue(null),
      findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue(customer(userId)),
    };
    const service = new ClientIdentityService(userRepository as never, {} as never);

    const result = await service.resolveContactLinkState({
      normalizedEmail: "nobody@example.com",
      phoneE164: "+35799123456",
    });

    expect(result).toEqual({ linkState: "IDENTITY_CONFLICT" });
  });

  it("does not link when email matches Customer A and phone matches a different Customer B", async () => {
    const userA = new Types.ObjectId();
    const userB = new Types.ObjectId();
    const userRepository = {
      findVerifiedCustomerByEmail: vi.fn().mockResolvedValue(customer(userA)),
      findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue(customer(userB)),
    };
    const service = new ClientIdentityService(userRepository as never, {} as never);

    const result = await service.resolveContactLinkState({
      normalizedEmail: "a@example.com",
      phoneE164: "+35799999999",
    });

    expect(result).toEqual({ linkState: "IDENTITY_CONFLICT" });
  });

  it("stays UNLINKED when neither signal matches any verified Customer", async () => {
    const userRepository = {
      findVerifiedCustomerByEmail: vi.fn().mockResolvedValue(null),
      findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue(null),
    };
    const service = new ClientIdentityService(userRepository as never, {} as never);

    const result = await service.resolveContactLinkState({
      normalizedEmail: "nobody@example.com",
      phoneE164: "+35799999999",
    });

    expect(result).toEqual({ linkState: "UNLINKED" });
  });
});

describe("ClientIdentityService.linkEligibleClientsForNewCustomer", () => {
  it("links every Client row that matches BOTH signals, across multiple Businesses", async () => {
    const customerId = new Types.ObjectId();
    const clientBusinessA = client(new Types.ObjectId());
    const clientBusinessB = client(new Types.ObjectId());
    const clientRepository = {
      findUnlinkedByEmail: vi.fn().mockResolvedValue([clientBusinessA, clientBusinessB]),
      findUnlinkedByPhoneE164: vi.fn().mockResolvedValue([clientBusinessA, clientBusinessB]),
      setLinkState: vi.fn().mockResolvedValue(null),
    };
    const service = new ClientIdentityService({} as never, clientRepository as never);

    await service.linkEligibleClientsForNewCustomer({
      userId: customerId,
      normalizedEmail: "maria@example.com",
      phoneE164: "+35799123456",
    });

    expect(clientRepository.setLinkState).toHaveBeenCalledTimes(2);
    expect(clientRepository.setLinkState).toHaveBeenCalledWith(String(clientBusinessA._id), {
      linkState: "LINKED",
      linkedUserId: customerId,
    });
    expect(clientRepository.setLinkState).toHaveBeenCalledWith(String(clientBusinessB._id), {
      linkState: "LINKED",
      linkedUserId: customerId,
    });
  });

  it("marks IDENTITY_CONFLICT (never links) for a Client that matches only one signal", async () => {
    const emailOnlyMatch = client(new Types.ObjectId());
    const phoneOnlyMatch = client(new Types.ObjectId());
    const clientRepository = {
      findUnlinkedByEmail: vi.fn().mockResolvedValue([emailOnlyMatch]),
      findUnlinkedByPhoneE164: vi.fn().mockResolvedValue([phoneOnlyMatch]),
      setLinkState: vi.fn().mockResolvedValue(null),
    };
    const service = new ClientIdentityService({} as never, clientRepository as never);

    await service.linkEligibleClientsForNewCustomer({
      userId: new Types.ObjectId(),
      normalizedEmail: "maria@example.com",
      phoneE164: "+35799123456",
    });

    expect(clientRepository.setLinkState).toHaveBeenCalledTimes(2);
    expect(clientRepository.setLinkState).toHaveBeenCalledWith(String(emailOnlyMatch._id), {
      linkState: "IDENTITY_CONFLICT",
    });
    expect(clientRepository.setLinkState).toHaveBeenCalledWith(String(phoneOnlyMatch._id), {
      linkState: "IDENTITY_CONFLICT",
    });
  });

  it("does nothing when no UNLINKED Client rows match either signal", async () => {
    const clientRepository = {
      findUnlinkedByEmail: vi.fn().mockResolvedValue([]),
      findUnlinkedByPhoneE164: vi.fn().mockResolvedValue([]),
      setLinkState: vi.fn(),
    };
    const service = new ClientIdentityService({} as never, clientRepository as never);

    await service.linkEligibleClientsForNewCustomer({
      userId: new Types.ObjectId(),
      normalizedEmail: "nobody@example.com",
      phoneE164: "+35799999999",
    });

    expect(clientRepository.setLinkState).not.toHaveBeenCalled();
  });
});
