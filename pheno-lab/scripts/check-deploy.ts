import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const scripts = [
  "deploy/scripts/build-release.sh",
  "deploy/scripts/deploy-release.sh",
  "scripts/backup.sh",
];

if (
  !statSync(
    path.join(process.cwd(), "scripts/validate-runtime-config.ts"),
  ).isFile()
) {
  throw new Error("runtime config preflight script is missing");
}

for (const script of scripts) {
  const absolute = path.join(process.cwd(), script);
  const syntax = spawnSync("/bin/bash", ["-n", absolute], {
    stdio: "inherit",
  });
  if (syntax.error) throw syntax.error;
  if (syntax.status !== 0) process.exit(syntax.status ?? 1);
  if ((statSync(absolute).mode & 0o111) === 0) {
    throw new Error(`${script} must be executable`);
  }
}

console.log("Deployment scripts passed syntax and permission checks.");
