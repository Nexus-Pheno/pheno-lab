import { spawnSync } from "node:child_process";

const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("verify must be started through pnpm");

const steps = [
  "format:check",
  "lint",
  "structure:check",
  "deploy:check",
  "typecheck",
  "test",
  "build",
];

for (const step of steps) {
  console.log(`\n[verify] ${step}`);
  const result = spawnSync(process.execPath, [pnpm, "run", step], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\n[verify] all checks passed");
