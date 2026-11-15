import type { PlatformSettingsService } from "../platform-settings/platform-settings.service.js";
import type { ServiceRepository } from "../services/service.repository.js";
import { AvailabilityError } from "./availability.errors.js";
import type { CompositeAvailabilityBody } from "./availability.schema.js";
import type { AvailabilityResult, AvailabilityService } from "./availability.service.js";

/** A conservative intersection of independently generated server slots. Every line has a
 * concrete professional; distinct staff guarantees no cross-line overlap or capacity join.
 * Creation always revalidates and reserves inside its existing transaction. */
export class CompositeAvailabilityService {
  constructor(
    private readonly availability: Pick<AvailabilityService, "getAvailability">,
    private readonly services: Pick<ServiceRepository, "findById">,
    private readonly settings: Pick<PlatformSettingsService, "getMaxServicesPerBooking">,
  ) {}

  async get(businessId: string, input: CompositeAvailabilityBody): Promise<AvailabilityResult> {
    if (input.lines.length > (await this.settings.getMaxServicesPerBooking()))
      throw new AvailabilityError("AVAILABILITY_TOO_MANY_SERVICES", 400);
    const staff = input.lines.map((line) => line.staffMembershipId.toLowerCase());
    if (new Set(staff).size !== staff.length)
      throw new AvailabilityError("AVAILABILITY_COMPOSITE_CONFLICT", 409);
    const results: AvailabilityResult[] = [];
    for (const line of input.lines) {
      const service = await this.services.findById(businessId, line.serviceId);
      if (!service || service.isPackageDeal)
        throw new AvailabilityError("AVAILABILITY_COMPOSITE_CONFLICT", 400);
      results.push(
        await this.availability.getAvailability({
          businessId,
          serviceId: line.serviceId,
          staffMembershipId: line.staffMembershipId,
          fromDate: input.fromDate,
          toDate: input.toDate,
          ...(input.customerCity ? { customerCity: input.customerCity } : {}),
          ...(line.hours !== undefined ? { hours: line.hours } : {}),
          ...(line.partySize !== undefined ? { partySize: line.partySize } : {}),
        }),
      );
    }
    const first = results[0];
    if (!first) throw new AvailabilityError("AVAILABILITY_COMPOSITE_CONFLICT", 400);
    return {
      ...first,
      days: first.days.map((day) => {
        const others = results
          .slice(1)
          .map((result) => result.days.find((d) => d.date === day.date));
        const slots = day.slots.flatMap((slot) => {
          if (!slot.eligibleStaffMembershipIds.some((id) => id.toLowerCase() === staff[0]))
            return [];
          const matched = others.map((other, index) =>
            other?.slots.find(
              (candidate) =>
                candidate.startAt === slot.startAt &&
                candidate.eligibleStaffMembershipIds.some(
                  (id) => id.toLowerCase() === staff[index + 1],
                ),
            ),
          );
          if (matched.some((candidate) => !candidate)) return [];
          const ends = [
            slot.endAt,
            ...matched.flatMap((candidate) => (candidate ? [candidate.endAt] : [])),
          ];
          return [
            {
              ...slot,
              endAt: ends.reduce((latest, end) => (end > latest ? end : latest)),
              eligibleStaffMembershipIds: staff,
            },
          ];
        });
        return {
          date: day.date,
          isOpen: day.isOpen && others.every((other) => other?.isOpen),
          slots,
        };
      }),
    };
  }
}
