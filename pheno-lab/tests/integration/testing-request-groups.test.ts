import { afterAll, expect, it } from "vitest";
import { db } from "@/infrastructure/db/client";
import {
  getTestingExperiment,
  listTestingExperiments,
} from "@/modules/testing/query";

afterAll(() => db.$disconnect());

it("groups the latest 20 experiments before limiting, retains all submissions, and scopes requester names", async () => {
  const suffix = crypto.randomUUID();
  const home = await db.organization.create({
    data: { name: "Testing groups", slug: `testing-groups-${suffix}` },
  });
  const foreign = await db.organization.create({
    data: {
      name: "Foreign testing groups",
      slug: `foreign-testing-groups-${suffix}`,
    },
  });
  const organizations = [home.id, foreign.id];
  try {
    const member = (
      organizationId: string,
      name: string,
      testingOnly = false,
    ) =>
      db.user.create({
        data: {
          organizationId,
          name,
          email: `${name}-${suffix}@example.test`,
          passwordHash: "fixture-only",
          role: testingOnly ? "TECHNICIAN" : "MANAGER",
          testingOnly,
        },
      });
    const first = await member(home.id, "First requester");
    const second = await member(home.id, "Second requester");
    const tester = await member(home.id, "Testing reader", true);
    const ordinary = await db.user.create({
      data: {
        organizationId: home.id,
        name: "Ordinary reader",
        email: `ordinary-${suffix}@example.test`,
        passwordHash: "fixture-only",
        role: "TECHNICIAN",
      },
    });
    const outsider = await member(foreign.id, "FOREIGN REQUESTER");
    const process = await db.process.create({
      data: { organizationId: home.id, name: "J-V", kind: "CHARACTERIZATION" },
    });
    const foreignProcess = await db.process.create({
      data: {
        organizationId: foreign.id,
        name: "J-V",
        kind: "CHARACTERIZATION",
      },
    });
    const createExperiment = (
      index: number,
      organizationId = home.id,
      createdById = first.id,
    ) =>
      db.experiment.create({
        data: {
          organizationId,
          createdById,
          code: `GROUP-${index}-${suffix}`,
          title: "PRIVATE PREPARATION TITLE",
          samples: { create: [{ code: "S1" }, { code: "S2" }, { code: "S3" }] },
          characterizations: {
            create: {
              position: 0,
              processId:
                organizationId === home.id ? process.id : foreignProcess.id,
              name: "J-V",
            },
          },
          runs: { create: [{ runNo: 1 }, { runNo: 2 }] },
        },
        include: {
          samples: { orderBy: { code: "asc" } },
          characterizations: true,
          runs: { orderBy: { runNo: "asc" } },
        },
      });
    const experiments: Awaited<ReturnType<typeof createExperiment>>[] = [];
    for (let index = 0; index < 21; index++)
      experiments.push(await createExperiment(index));
    const distant = await createExperiment(22, foreign.id, outsider.id);
    const requestData = (
      experiment: typeof distant,
      requestedById: string,
      sampleIds: string[],
      createdAt: Date,
      runIndex = 0,
    ) => ({
      organizationId: experiment.organizationId,
      experimentId: experiment.id,
      characterizationId: experiment.characterizations[0].id,
      runId: experiment.runs[runIndex].id,
      requestedById,
      sampleIds,
      createdAt,
      note: "Testing note",
      photoPath: "fixture-only.png",
      requestKey: crypto.randomUUID(),
    });
    await db.testingRequest.createMany({
      data: experiments.map((experiment, index) =>
        requestData(
          experiment,
          first.id,
          [experiment.samples[0].id],
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        ),
      ),
    });
    const repeated = experiments[0];
    await db.testingRequest.createMany({
      data: Array.from({ length: 55 }, (_, index) =>
        requestData(
          repeated,
          second.id,
          [repeated.samples[1].id],
          new Date(Date.UTC(2026, 0, 2, 0, 0, index)),
          1,
        ),
      ),
    });
    await db.testingRequest.create({
      data: requestData(
        distant,
        outsider.id,
        [distant.samples[0].id],
        new Date(Date.UTC(2026, 0, 3)),
      ),
    });
    const actor = {
      uid: tester.id,
      org: home.id,
      role: "TECHNICIAN" as const,
      testingOnly: true,
    };
    const before = await db.testingRequest.findMany({ orderBy: { id: "asc" } });
    const list = await listTestingExperiments(actor, {});
    expect(list.total).toBe(21);
    expect(list.recentRequests).toHaveLength(20);
    expect(new Set(list.recentRequests.map((r) => r.experimentId)).size).toBe(
      20,
    );
    expect(list.recentRequests[0]).toMatchObject({
      experimentId: repeated.id,
      submissionCount: 56,
      requesters: [second.name, first.name],
    });
    expect(list.recentRequests[0].samples.map((s) => s.code)).toEqual([
      "S1",
      "S2",
    ]);
    expect(
      list.recentRequests.some((r) => r.experimentId === experiments[1].id),
    ).toBe(false);
    expect(
      list.recentRequests.some((r) => r.experimentId === experiments[2].id),
    ).toBe(true);
    const detail = await getTestingExperiment(actor, repeated.id);
    expect(detail?.requests).toHaveLength(56);
    expect(detail?.requestSummary).toMatchObject({
      submissionCount: 56,
      requesters: [second.name, first.name],
    });
    expect(detail?.requestSummary.samples.map((s) => s.code)).toEqual([
      "S1",
      "S2",
    ]);
    expect(detail?.requests[0]).toMatchObject({
      requestedByName: second.name,
      runNo: 2,
    });
    expect(detail?.requests.at(-1)).toMatchObject({
      requestedByName: first.name,
      runNo: 1,
    });
    expect(JSON.stringify({ list, detail })).not.toMatch(
      /PRIVATE|FOREIGN REQUESTER|@example.test|passwordHash|photoPath|organizationId/,
    );
    expect(await getTestingExperiment(actor, distant.id)).toBeNull();
    const ordinaryActor = {
      uid: ordinary.id,
      org: home.id,
      role: "TECHNICIAN" as const,
    };
    expect(
      (await listTestingExperiments(ordinaryActor, {})).recentRequests,
    ).toEqual([]);
    expect(await getTestingExperiment(ordinaryActor, repeated.id)).toBeNull();
    expect(
      await db.testingRequest.findMany({ orderBy: { id: "asc" } }),
    ).toEqual(before);
    // Malformed cross-organization author references must not expose a foreign name.
    const invalidAuthor = await db.testingRequest.create({
      data: requestData(
        repeated,
        outsider.id,
        [repeated.samples[0].id],
        new Date(Date.UTC(2026, 0, 4)),
      ),
    });
    const redacted = await getTestingExperiment(actor, repeated.id);
    expect(
      redacted?.requests.find((r) => r.id === invalidAuthor.id)
        ?.requestedByName,
    ).toBeNull();
    expect(
      JSON.stringify(await listTestingExperiments(actor, {})),
    ).not.toContain(outsider.name);
    expect(redacted?.requestSummary.requesters).toEqual([
      second.name,
      first.name,
    ]);
  } finally {
    await db.experiment.deleteMany({
      where: { organizationId: { in: organizations } },
    });
    await db.process.deleteMany({
      where: { organizationId: { in: organizations } },
    });
    await db.user.deleteMany({
      where: { organizationId: { in: organizations } },
    });
    await db.organization.deleteMany({ where: { id: { in: organizations } } });
  }
});
