import { expect, it } from "vitest";
import { invertVisibleSelection } from "./selection";

it("inverts only rendered thumbnails and drops an offscreen selection", () => {
  expect([...invertVisibleSelection([1, 2, 3], new Set([2, 99]))]).toEqual([1, 3]);
});
