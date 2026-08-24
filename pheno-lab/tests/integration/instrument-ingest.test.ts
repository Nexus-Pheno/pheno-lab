import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { objectStorage } from "@/infrastructure/storage";
import { ingestInstrumentUpload } from "@/modules/instruments/ingest-service";
import { rematchMeasurements } from "@/modules/instruments/measurement-rematch-service";

afterAll(async () => {
  await db.$disconnect();
});

describe("instrument ingest contract", () => {
  it("stores, de-duplicates, and later re-matches a real fixture", async () => {
    const suffix = crypto.randomUUID();
    const org = await db.organization.create({
      data: { name: "Instrument Test Org", slug: `instrument-${suffix}` },
    });
    const user = await db.user.create({
      data: {
        organizationId: org.id,
        email: `instrument-owner-${suffix}@example.test`,
        name: "Instrument Owner",
        passwordHash: "test-only",
        role: "ADMIN",
      },
    });
    const instrument = await db.instrument.create({
      data: {
        organizationId: org.id,
        name: `GiantForce ${suffix}`,
        kind: "GIANTFORCE_IV",
        apiKeyHash: `test-${suffix}`,
      },
    });
    const fixture = await readFile(
      path.join(
        process.cwd(),
        "src/lib/instruments/__fixtures__/giantforce-auto-single.csv",
      ),
    );
    const objectKeys: string[] = [];

    try {
      const first = await ingestInstrumentUpload(instrument, {
        body: fixture,
        fileName: "C1-1_Cindy_perovskite_Light_Normal_Rev_1_143040.csv",
        sourcePath: "D:\\GiantForce\\scan.csv",
        sourceDir: "D:\\GiantForce",
        modifiedAt: new Date("2026-08-20T06:30:40Z"),
        mime: "text/csv",
      });
      expect(first).toMatchObject({
        statusCode: 200,
        body: { status: "unmatched", scans: 1 },
      });

      const upload = await db.instrumentUpload.findFirstOrThrow({
        where: { instrumentId: instrument.id },
      });
      objectKeys.push(upload.storedPath);
      expect(await objectStorage().exists(upload.storedPath)).toBe(true);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: org.id,
            instrumentId: instrument.id,
            action: "instrument.upload.parse",
          },
        }),
      ).toBe(1);

      const duplicate = await ingestInstrumentUpload(instrument, {
        body: fixture,
        fileName: "retry.csv",
        sourcePath: "",
        sourceDir: "",
        modifiedAt: null,
        mime: "text/csv",
      });
      expect(duplicate).toMatchObject({
        statusCode: 409,
        body: { status: "duplicate", scans: 0 },
      });

      const experiment = await db.experiment.create({
        data: {
          organizationId: org.id,
          code: `2026-101-1-${suffix}`,
          title: "Late experiment record",
          createdById: user.id,
          samples: {
            create: { code: "S1", instrumentCodes: ["C1"] },
          },
        },
      });
      const summary = await rematchMeasurements({ organizationId: org.id });
      expect(summary).toMatchObject({
        considered: 1,
        matched: 1,
        stillUnmatched: 0,
        samplesUpdated: 1,
      });
      expect(
        await db.jvMeasurement.count({
          where: {
            organizationId: org.id,
            experimentId: experiment.id,
            status: "MATCHED",
          },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: org.id,
            action: "instrument.measurement.rematched",
          },
        }),
      ).toBe(1);
    } finally {
      await db.auditEvent.deleteMany({ where: { organizationId: org.id } });
      await db.instrument.deleteMany({ where: { organizationId: org.id } });
      await db.experiment.deleteMany({ where: { organizationId: org.id } });
      await db.user.deleteMany({ where: { organizationId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
      for (const key of objectKeys) await objectStorage().delete(key);
    }
  });
});
