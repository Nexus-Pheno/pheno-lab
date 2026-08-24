import "server-only";

type LogLevel = "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | null | undefined>;

function write(level: LogLevel, event: string, fields: Fields = {}): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "pheno-lab",
    event,
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ),
  });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}

export const log = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
