import type { Request, Response } from "express";
import { expect, it, vi } from "vitest";
import { IntegrationController } from "../../src/modules/integration/integration.controller.js";
import type { IntegrationService } from "../../src/modules/integration/integration.service.js";

it.each(["connected", "denied", "failed"])(
  "the %s callback returns to the actual Settings section",
  async (outcome) => {
    const handleOAuthCallback =
      outcome === "failed"
        ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
        : vi.fn().mockResolvedValue(undefined);
    const controller = new IntegrationController({
      handleOAuthCallback,
    } as unknown as IntegrationService);
    const redirect = vi.fn();
    const query =
      outcome === "denied"
        ? { error: "access_denied", state: "test-state" }
        : { code: "test-code", state: "test-state" };
    await controller.handleGoogleCalendarCallback(
      { validated: { query } } as unknown as Request,
      { redirect } as unknown as Response,
    );
    const url = new URL(redirect.mock.calls[0]?.[0] as string);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/business-dashboard");
    expect(url.searchParams.get("section")).toBe("settings");
    expect(url.searchParams.get("settingsTab")).toBe("Integration");
    expect(url.searchParams.get("googleCalendar")).toBe(
      outcome === "connected" ? "connected" : "error",
    );
    if (outcome === "denied") expect(handleOAuthCallback).not.toHaveBeenCalled();
  },
);
