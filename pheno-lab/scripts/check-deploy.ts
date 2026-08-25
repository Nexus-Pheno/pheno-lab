import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

const deploymentFiles = {
  env: readFileSync(
    path.join(process.cwd(), "deploy/pheno-lab.env.example"),
    "utf8",
  ),
  nginx: readFileSync(
    path.join(process.cwd(), "deploy/nginx/pheno-lab.conf.example"),
    "utf8",
  ),
  service: readFileSync(
    path.join(process.cwd(), "deploy/systemd/pheno-lab.service"),
    "utf8",
  ),
};

if (!deploymentFiles.env.includes("STORAGE_DRIVER=cos")) {
  throw new Error("production env template must use COS storage");
}
if (!deploymentFiles.env.includes("BACKUP_MODE=external")) {
  throw new Error("production env template must use external database backups");
}
if (!deploymentFiles.nginx.includes("server_name lab.szkl.com;")) {
  throw new Error("nginx template must serve lab.szkl.com");
}
if (
  /\/var\/lib\/pheno-lab\/(?:uploads|backups)/.test(deploymentFiles.service)
) {
  throw new Error(
    "application service must not write uploads or backups on the app CVM",
  );
}
if (!deploymentFiles.service.includes(".next/cache")) {
  throw new Error("application service must allow the Next.js runtime cache");
}

console.log("Deployment scripts passed syntax and permission checks.");
