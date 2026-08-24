import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const failures: string[] = [];

function filesBelow(directory: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = statSync(file);
    if (stat.isDirectory()) result.push(...filesBelow(file));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts"))
      result.push(file);
  }
  return result;
}

for (const file of filesBelow(sourceRoot)) {
  const relative = path.relative(root, file);
  const source = readFileSync(file, "utf8");
  const isClient = /^\s*["']use client["'];/m.test(source);

  if (isClient && /from\s+["']@\/lib\/db["']/.test(source)) {
    failures.push(`${relative}: Client Component imports the Prisma singleton`);
  }
  if (isClient && /from\s+["']@\/infrastructure\//.test(source)) {
    failures.push(
      `${relative}: Client Component imports server infrastructure`,
    );
  }
  if (
    isClient &&
    /import\s+(?!type\b)[^;]+from\s+["']@prisma\/client["']/.test(source)
  ) {
    failures.push(
      `${relative}: Client Component imports Prisma as a runtime dependency`,
    );
  }
  if (
    relative.startsWith(`src${path.sep}modules${path.sep}`) &&
    /from\s+["']@\/(app|components)\//.test(source)
  ) {
    failures.push(`${relative}: domain module imports app/components`);
  }
  if (
    relative.startsWith(`src${path.sep}modules${path.sep}`) &&
    /from\s+["']@\/lib\/actions\//.test(source)
  ) {
    failures.push(`${relative}: domain module imports a transport action`);
  }
  if (
    relative.startsWith(`src${path.sep}modules${path.sep}`) &&
    /from\s+["']next\//.test(source)
  ) {
    failures.push(`${relative}: domain module imports the Next.js transport`);
  }

  const isTransport =
    relative.startsWith(`src${path.sep}app${path.sep}`) ||
    relative.startsWith(`src${path.sep}lib${path.sep}actions${path.sep}`);
  if (isTransport && /from\s+["']@\/lib\/db["']/.test(source)) {
    failures.push(`${relative}: transport imports the Prisma singleton`);
  }
  if (isTransport && /from\s+["']@\/infrastructure\//.test(source)) {
    failures.push(`${relative}: transport imports infrastructure directly`);
  }
  if (/from\s+["']@\/lib\/(db|mail)["']/.test(source)) {
    failures.push(
      `${relative}: database and mail adapters belong in infrastructure`,
    );
  }

  const isServerModule =
    relative.startsWith(`src${path.sep}modules${path.sep}`) &&
    /(?:^|[-/])(service|query)\.ts$/.test(relative.replaceAll(path.sep, "/"));
  if (isServerModule && !/import\s+["']server-only["'];/.test(source)) {
    failures.push(
      `${relative}: server module is missing the server-only guard`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    "Architecture boundary violations:\n" +
      failures.map((x) => `- ${x}`).join("\n"),
  );
  process.exit(1);
}

console.log("Architecture boundaries passed.");
