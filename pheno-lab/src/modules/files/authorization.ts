import "server-only";

import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { canReadExperiment } from "@/modules/authorization/policy";

const SAFE_KEY = /^[a-zA-Z0-9._/-]+$/;

export async function canReadObject(
  actor: Actor,
  key: string,
): Promise<boolean> {
  if (!key || key.includes("..") || !SAFE_KEY.test(key)) return false;

  const parts = key.split("/");
  if (parts[0] === "organizations") {
    if (parts[1] !== actor.org) return false;
    // A newly uploaded image is readable by its uploader before the form is
    // saved and creates a database reference. Afterwards the resource checks
    // below also let authorized collaborators read it.
    if (parts[2] === "users" && parts[3] === actor.uid) return true;
    if (parts[2] === "instruments" && actor.role !== "TECHNICIAN") return true;
  }

  // Legacy objects and new objects opened by someone other than their uploader
  // must resolve to a business record the actor may actually read.
  const [stepAttachment, resultAttachment, feedback, equipment] =
    await Promise.all([
      db.attachment.findFirst({
        where: { storedPath: key, stepExecutionId: { not: null } },
        select: {
          stepExecution: {
            select: {
              run: {
                select: {
                  experiment: {
                    select: {
                      organizationId: true,
                      createdById: true,
                      assigneeId: true,
                      members: { select: { userId: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      db.attachment.findFirst({
        where: { storedPath: key, characterizationResultId: { not: null } },
        select: {
          characterizationResult: {
            select: {
              characterization: {
                select: {
                  experiment: {
                    select: {
                      organizationId: true,
                      createdById: true,
                      assigneeId: true,
                      members: { select: { userId: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      db.feedback.findFirst({
        where: { organizationId: actor.org, screenshotPath: key },
        select: { userId: true },
      }),
      db.equipment.findFirst({
        where: { organizationId: actor.org, photoPath: key },
        select: { id: true },
      }),
    ]);

  const stepExperiment = stepAttachment?.stepExecution?.run.experiment;
  if (stepExperiment && canReadExperiment(actor, stepExperiment)) return true;

  const resultExperiment =
    resultAttachment?.characterizationResult?.characterization.experiment;
  if (resultExperiment && canReadExperiment(actor, resultExperiment))
    return true;

  if (feedback && (feedback.userId === actor.uid || actor.role === "ADMIN")) {
    return true;
  }
  return Boolean(equipment);
}
