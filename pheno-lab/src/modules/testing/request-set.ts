import { createHash } from "node:crypto";

/** Stable batch identity shared by completion notices and manual corrections. */
export function testingRequestSetKey(ids: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...ids].sort()))
    .digest("hex");
}
