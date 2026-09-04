import "server-only";

import { db } from "@/infrastructure/db/client";
import { listAiProviders } from "@/modules/ai/service";
import type { Actor } from "@/modules/authorization/actor";
import { assertAdmin } from "@/modules/authorization/policy";
import { experimentVisibilityScope } from "@/modules/authorization/scope";

const feedbackInclude = {
  user: { select: { name: true, email: true } },
  reviewedBy: { select: { name: true } },
  attachments: { select: { id: true, fileName: true, storedPath: true } },
} as const;

export async function listFeedback(actor: Actor) {
  assertAdmin(actor);
  return db.feedback.findMany({
    where: { organizationId: actor.org },
    orderBy: { createdAt: "desc" },
    include: feedbackInclude,
  });
}

/** A reporter's own submissions, with the admin's verdict and comments. */
export async function listMyFeedback(actor: Actor) {
  return db.feedback.findMany({
    where: { organizationId: actor.org, userId: actor.uid },
    orderBy: { createdAt: "desc" },
    include: feedbackInclude,
  });
}

export async function exportFeedback(actor: Actor) {
  assertAdmin(actor);
  return db.feedback.findMany({
    where: { organizationId: actor.org },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { name: true, email: true, role: true } },
      reviewedBy: { select: { name: true } },
      attachments: { select: { fileName: true, storedPath: true } },
    },
  });
}

export async function getProfileData(actor: Actor) {
  const where = experimentVisibilityScope(actor);
  const [user, organization, experiments, completed, presetCount, aiProviders] =
    await Promise.all([
      db.user.findFirstOrThrow({
        where: { id: actor.uid, organizationId: actor.org, active: true },
      }),
      db.organization.findUniqueOrThrow({ where: { id: actor.org } }),
      db.experiment.findMany({
        where,
        select: {
          id: true,
          _count: { select: { samples: true } },
          steps: {
            select: {
              _count: { select: { parameters: true, materials: true } },
              parameters: {
                select: { _count: { select: { variations: true } } },
              },
            },
          },
          characterizations: { select: { settings: true } },
        },
      }),
      db.experiment.count({ where: { AND: [where, { status: "COMPLETE" }] } }),
      db.preset.count({
        where: { organizationId: actor.org, createdById: actor.uid },
      }),
      actor.role === "ADMIN" ? listAiProviders(actor) : Promise.resolve([]),
    ]);

  let samples = 0;
  let dataPoints = 0;
  for (const experiment of experiments) {
    samples += experiment._count.samples;
    for (const step of experiment.steps) {
      dataPoints += step._count.parameters + step._count.materials;
      for (const parameter of step.parameters) {
        dataPoints += parameter._count.variations;
      }
    }
    for (const characterization of experiment.characterizations) {
      dataPoints += Object.keys(
        (characterization.settings ?? {}) as object,
      ).length;
    }
  }
  return {
    user,
    organization,
    aiProviders,
    statistics: {
      experiments: experiments.length,
      completed,
      samples,
      dataPoints,
      presets: presetCount,
    },
  };
}
