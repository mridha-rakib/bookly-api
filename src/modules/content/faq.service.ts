import { Types } from "mongoose";
import type { FaqAudience, FaqStatus } from "./content.types.js";
import { type FaqDto, type PublicFaqDto, toFaqDto, toPublicFaqDto } from "./faq.dto.js";
import { FaqError } from "./faq.errors.js";
import type { CreateFaqInput, FaqRepository, UpdateFaqInput } from "./faq.repository.js";

export type CreateFaqRequest = {
  question: string;
  answer: string;
  audience: FaqAudience;
  status: FaqStatus;
};

export type UpdateFaqRequest = {
  question?: string | undefined;
  answer?: string | undefined;
  status?: FaqStatus | undefined;
};

/**
 * FAQ domain service. SUPER_ADMIN-only writers (enforced at the route layer, same router-wide
 * gate as every other Super Admin surface — never re-checked here). The one public consumer is
 * `listPublished`, which is the ONLY method that filters to PUBLISHED.
 */
export class FaqService {
  public constructor(private readonly faqRepository: FaqRepository) {}

  /** Content Manager FAQ tab — all statuses for the audience unless `status` narrows it. */
  public async listForAdmin(audience: FaqAudience, status?: FaqStatus): Promise<FaqDto[]> {
    const faqs = await this.faqRepository.listByAudience(audience, { status });
    return faqs.map(toFaqDto);
  }

  /** Public read — PUBLISHED only, ordered by the persisted `order`. Drafts never appear here. */
  public async listPublished(audience: FaqAudience): Promise<PublicFaqDto[]> {
    const faqs = await this.faqRepository.listByAudience(audience, { status: "PUBLISHED" });
    return faqs.map(toPublicFaqDto);
  }

  public async create(superAdminUserId: string, request: CreateFaqRequest): Promise<FaqDto> {
    const maxOrder = await this.faqRepository.maxOrderForAudience(request.audience);
    const input: CreateFaqInput = {
      question: request.question,
      answer: request.answer,
      audience: request.audience,
      status: request.status,
      order: maxOrder === null ? 0 : maxOrder + 1,
      createdByUserId: new Types.ObjectId(superAdminUserId),
    };
    const created = await this.faqRepository.create(input);
    return toFaqDto(created);
  }

  public async update(faqId: string, request: UpdateFaqRequest): Promise<FaqDto> {
    const patch: UpdateFaqInput = {};
    if (request.question !== undefined) patch.question = request.question;
    if (request.answer !== undefined) patch.answer = request.answer;
    if (request.status !== undefined) patch.status = request.status;

    const updated = await this.faqRepository.update(faqId, patch);
    if (!updated) {
      throw new FaqError("FAQ_NOT_FOUND", 404);
    }
    return toFaqDto(updated);
  }

  public async delete(faqId: string): Promise<{ id: string }> {
    const existing = await this.faqRepository.findById(faqId);
    if (!existing) {
      throw new FaqError("FAQ_NOT_FOUND", 404);
    }
    await this.faqRepository.delete(faqId);
    return { id: faqId };
  }

  /**
   * Persists a new ordering for one audience. Rejects the whole request (nothing written) unless
   * `orderedIds` is exactly the set of FAQ ids for that audience — every id present, each once,
   * none belonging to another audience or already deleted. This is what stops a stale or partial
   * client list from silently corrupting the sequence.
   */
  public async reorder(audience: FaqAudience, orderedIds: string[]): Promise<FaqDto[]> {
    const current = await this.faqRepository.listByAudience(audience);
    const currentIds = new Set(current.map((faq) => String(faq._id)));
    const requestedIds = new Set(orderedIds);

    const sameSize = currentIds.size === requestedIds.size;
    const sameMembers = [...requestedIds].every((id) => currentIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new FaqError("FAQ_REORDER_MISMATCH", 400);
    }

    await this.faqRepository.reorder(audience, orderedIds);
    return this.listForAdmin(audience);
  }
}
