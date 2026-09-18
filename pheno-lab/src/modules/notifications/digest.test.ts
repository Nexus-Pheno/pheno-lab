import { describe, expect, it } from "vitest";
import {
  activityLine,
  championPce,
  championScan,
  digestWindow,
} from "./digest";

describe("morning digest", () => {
  it("uses the previous calendar day in Asia/Shanghai", () => {
    expect(digestWindow(new Date("2026-09-07T00:30:00Z"))).toEqual({
      date: "2026-09-07",
      start: new Date("2026-09-05T16:00:00Z"),
      end: new Date("2026-09-06T16:00:00Z"),
    });
    expect(digestWindow(new Date("2026-09-06T16:01:00Z")).date).toBe(
      "2026-09-07",
    );
  });
  it("excludes missing, nonnumeric and invalid PCE values", () => {
    expect(
      championPce([
        { metrics: null },
        { metrics: {} },
        { metrics: { pce: "25" } },
        { metrics: { pce: 101 } },
        { metrics: { pce: -2 } },
        { metrics: { pce: Infinity } },
      ]),
    ).toBeNull();
    expect(
      championPce([
        { metrics: { pce: 0 } },
        { metrics: { pce: 20.123 } },
        { metrics: { pce: 21.56 } },
      ]),
    ).toBe(21.56);
  });

  it("names who ran the best scan — assignee first, creator otherwise", () => {
    const exp = (code: string, creator: string, assignee: string | null) => ({
      code,
      createdBy: { name: creator },
      assignee: assignee ? { name: assignee } : null,
    });
    expect(
      championScan([
        { metrics: { pce: 20 }, experiment: exp("E-1", "Lily", null) },
        { metrics: { pce: 22.5 }, experiment: exp("E-2", "Roger", "Dennis") },
        { metrics: { pce: 101 }, experiment: exp("E-3", "Nobody", null) },
      ]),
    ).toEqual({ pce: 22.5, code: "E-2", who: "Dennis" });
    expect(
      championScan([{ metrics: { pce: "25" }, experiment: null }]),
    ).toBeNull();
  });

  it("lists yesterday's people busiest first", () => {
    expect(
      activityLine([
        { name: "Joey", experiments: 1 },
        { name: "Lily", experiments: 3 },
        { name: "Dennis", experiments: 3 },
      ]),
    ).toBe("Dennis 3、Lily 3、Joey 1");
    expect(activityLine([])).toBe("暂无");
  });
});
