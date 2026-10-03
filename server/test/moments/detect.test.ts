import { describe, expect, it } from "vitest";
import { detectMoments } from "../../src/moments/detect.js";

describe("detectMoments", () => {
  it("groups three active days separated by at most one inactive day", () => {
    const result = detectMoments([
      { date: "2025-03-01", mediaCount: 12 },
      { date: "2025-03-03", mediaCount: 14 },
      { date: "2025-03-04", mediaCount: 16 },
      { date: "2025-03-07", mediaCount: 11 },
      { date: "2025-03-08", mediaCount: 2 },
    ], "balanced");
    expect(result).toEqual([
      { kind: "event", startDate: "2025-03-07", endDate: "2025-03-07", calendarDays: 1, mediaCount: 11, activeDays: [{ date: "2025-03-07", mediaCount: 11 }] },
      { kind: "multi-day", startDate: "2025-03-01", endDate: "2025-03-04", calendarDays: 4, mediaCount: 42, activeDays: [
        { date: "2025-03-01", mediaCount: 12 }, { date: "2025-03-03", mediaCount: 14 }, { date: "2025-03-04", mediaCount: 16 },
      ] },
    ]);
  });

  it("makes detailed detection more sensitive than broad detection", () => {
    const days = [{ date: "2025-01-01", mediaCount: 5 }];
    expect(detectMoments(days, "broad")).toHaveLength(0);
    expect(detectMoments(days, "detailed")).toHaveLength(1);
  });
});
