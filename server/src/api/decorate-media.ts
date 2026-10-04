import type { MediaDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { EngagementRepo } from "../db/engagement-repo.js";

// Everything a listing must add on top of toMediaDto - favorites and stack
// membership - in one call so no route forgets one of them.
export function decorateMedia(ctx: AppContext, items: MediaDto[]): MediaDto[] {
  new EngagementRepo(ctx.db).attachFavorites(items);
  ctx.stacks.attachStacks(items);
  for (const item of items) {
    if (item.sourceKind === "apple-photos" && ctx.applePreparation?.readPath(item.id)) item.thumbnailStatus = "done";
  }
  return items;
}
