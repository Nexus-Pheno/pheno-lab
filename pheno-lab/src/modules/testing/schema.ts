import { z } from "zod";

export function isJvTesting(name: string, processName = ""): boolean {
  return /j[\s\-–−]?v|solar|太阳|伏安|电流.?电压/i.test(
    `${name} ${processName}`,
  );
}

export const testingRequestSchema = z.object({
  characterizationId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  sampleIds: z.array(z.string().min(1).max(128)).min(1).max(1000),
  photoPath: z.string().min(1).max(512),
  note: z.string().trim().max(2000).default(""),
  requestKey: z.uuid(),
});

export const testingSearchSchema = z.object({
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
