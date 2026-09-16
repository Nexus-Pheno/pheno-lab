import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { recountDataPoints } from "@/modules/instruments/data-points-service";

afterAll(async () => {
  await db.$disconnect();
});

describe("data-point running total against PostgreSQL", () => {
  it("recounts every (x, y) point of every stored curve, per organization", async () => {
    const suffix = crypto.randomUUID();
    const organization = await db.organization.create({
      data: { name: "Points", slug: `pts-${suffix}` },
    });
    const other = await db.organization.create({
      data: { name: "Points other", slug: `pts-o-${suffix}` },
    });
    try {
      const instrument = await db.instrument.create({
        data: {
          organizationId: organization.id,
          name: `LIGHTSKY-${suffix}`,
          kind: "LIGHTSKY_LIV",
          apiKeyHash: `hash-${suffix}`,
        },
      });
      const upload = await db.instrumentUpload.create({
        data: {
          instrumentId: instrument.id,
          fileName: "a.csv",
          storedPath: `test/${suffix}.csv`,
          sha256: suffix,
          size: 1,
          status: "PARSED",
        },
      });
      const curve = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ v: i / 10, i: 1 - i / 10 }));
      for (const [key, n] of [
        ["s1", 120],
        ["s2", 80],
      ] as const) {
        await db.jvMeasurement.create({
          data: {
            organizationId: organization.id,
            instrumentId: instrument.id,
            uploadId: upload.id,
            serial: key,
            serialKey: key,
            scanKey: `${key}-${suffix}`,
            metrics: { pce: 20 },
            curve: curve(n),
            settings: {},
            status: "UNMATCHED",
          },
        });
      }
      // A counter that drifted is set straight from the curves.
      await db.organization.update({
        where: { id: organization.id },
        data: { dataPoints: 5 },
      });
      const counts = await recountDataPoints();
      expect(
        counts.find((c) => c.organizationId === organization.id)?.dataPoints,
      ).toBe(200);
      expect(
        counts.find((c) => c.organizationId === other.id)?.dataPoints,
      ).toBe(0);
      const row = await db.organization.findUniqueOrThrow({
        where: { id: organization.id },
        select: { dataPoints: true },
      });
      expect(row.dataPoints).toBe(200);
    } finally {
      await db.jvMeasurement.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.instrumentUpload.deleteMany({
        where: { instrument: { organizationId: organization.id } },
      });
      await db.instrument.deleteMany({
        where: { organizationId: organization.id },
      });
      await db.organization.delete({ where: { id: organization.id } });
      await db.organization.delete({ where: { id: other.id } });
    }
  });
});
