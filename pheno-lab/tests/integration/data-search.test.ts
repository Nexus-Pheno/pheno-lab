import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import { loadDataPage } from "@/modules/data/query";

afterAll(async () => {
  await db.$disconnect();
});

async function removeOrganization(organizationId: string): Promise<void> {
  await db.experiment.deleteMany({ where: { organizationId } });
  await db.process.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.organization.delete({ where: { id: organizationId } });
}

describe("data table search against PostgreSQL", () => {
  it("finds an experiment by the person, the material and the step text, and names columns by process", async () => {
    const suffix = crypto.randomUUID();
    const organization = await db.organization.create({
      data: { name: "Search", slug: `search-${suffix}` },
    });
    try {
      const joey = await db.user.create({
        data: {
          organizationId: organization.id,
          email: `joey-${suffix}@example.test`,
          name: "Joey Guo",
          passwordHash: "test-only",
          role: "MANAGER",
        },
      });
      const process = await db.process.create({
        data: {
          organizationId: organization.id,
          name: "Blade coating",
          position: 0,
          kind: "PROCESSING",
        },
      });
      await db.experiment.create({
        data: {
          organizationId: organization.id,
          code: `SRCH-${suffix.slice(0, 6)}`,
          title: "First solar打样调试",
          createdById: joey.id,
          samples: { create: [{ code: "S1" }] },
          steps: {
            create: [
              {
                position: 1,
                processId: process.id,
                // Imported steps carry the whole condition string as their name.
                name: "SAM deposition — CELL4 0.8浓度，纯甲醇体系，20倍旋涂1500RPM-30S",
                parameters: {
                  create: [{ position: 0, name: "SAM退火温度", value: "100℃" }],
                },
              },
            ],
          },
        },
      });
      const base = { organizationId: organization.id };
      const byPerson = await loadDataPage(base, { q: "Joey" });
      expect(byPerson.rows).toHaveLength(1);
      const byStepText = await loadDataPage(base, { q: "纯甲醇" });
      expect(byStepText.rows).toHaveLength(1);
      const byValue = await loadDataPage(base, { q: "100℃" });
      expect(byValue.rows).toHaveLength(1);
      const miss = await loadDataPage(base, { q: "nobody-here" });
      expect(miss.rows).toHaveLength(0);

      // A second, older experiment: with no query the newest is first; with
      // ranked ids the page follows the ranking, whatever the dates say.
      const older = await db.experiment.create({
        data: {
          organizationId: organization.id,
          code: `SRCH-OLD-${suffix.slice(0, 6)}`,
          title: "Older batch",
          createdById: joey.id,
          createdAt: new Date("2025-01-01T00:00:00Z"),
          samples: { create: [{ code: "S1" }] },
        },
      });
      const newestFirst = await loadDataPage(base, {});
      expect(newestFirst.rows[0].Experiment).toBe(`SRCH-${suffix.slice(0, 6)}`);
      expect(newestFirst.rows[1].Experiment).toBe(older.code);
      const newer = (
        await db.experiment.findFirstOrThrow({
          where: { code: `SRCH-${suffix.slice(0, 6)}` },
        })
      ).id;
      const ranked = await loadDataPage(base, { ids: [older.id, newer] });
      expect(ranked.total).toBe(2);
      expect(ranked.rows[0].Experiment).toBe(older.code);

      // Headers are named after the process; the step's text has its own
      // column instead of leaking into every parameter header.
      expect(byPerson.columns).toContain("02 Blade coating · Step");
      expect(byPerson.columns).toContain("02 Blade coating · SAM退火温度");
      expect(byPerson.columns.some((c) => c.includes("纯甲醇"))).toBe(false);
      expect(byPerson.rows[0]["02 Blade coating · Step"]).toContain("纯甲醇");
    } finally {
      await removeOrganization(organization.id);
    }
  });
});
