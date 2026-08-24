export function normalizeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0"),
    )
  ) {
    throw new Error("Invalid object key");
  }
  return normalized;
}
