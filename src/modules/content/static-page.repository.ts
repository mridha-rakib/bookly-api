import type { Types } from "mongoose";
import type { StaticPageKey } from "./content.types.js";
import { type StaticPageDocument, StaticPageModel } from "./static-page.model.js";

export type UpsertStaticPageInput = {
  title: string;
  bodyHtml: string;
  actorUserId: Types.ObjectId;
};

export class StaticPageRepository {
  public async findByKey(pageKey: StaticPageKey): Promise<StaticPageDocument | null> {
    return StaticPageModel.findOne({ pageKey }).exec();
  }

  public async listAll(): Promise<StaticPageDocument[]> {
    return StaticPageModel.find({}).exec();
  }

  /**
   * Create-or-update the single row for `pageKey`. `$setOnInsert` stamps `createdByUserId` only
   * on the first save; `updatedByUserId` is set every time. Concurrency-safe via the unique
   * `pageKey` index + `upsert`.
   */
  public async upsert(
    pageKey: StaticPageKey,
    input: UpsertStaticPageInput,
  ): Promise<StaticPageDocument> {
    return StaticPageModel.findOneAndUpdate(
      { pageKey },
      {
        $set: {
          title: input.title,
          bodyHtml: input.bodyHtml,
          updatedByUserId: input.actorUserId,
        },
        $setOnInsert: { pageKey, createdByUserId: input.actorUserId },
      },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<StaticPageDocument>;
  }
}
