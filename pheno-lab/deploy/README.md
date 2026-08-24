# Pheno Lab deployment (Ubuntu + systemd)

The repository is ready for the first deployment milestone: one Next.js
process, PostgreSQL, and an external local upload directory. It also contains
the production COS adapter and migration-time read fallback, but COS is not a
prerequisite for bringing up the Web application. The canonical architecture
and data migration procedure are documented in
`../../docs/architecture-refactor.md`.

## 1. Host prerequisites

- Ubuntu 24.04 LTS, with Nginx, `curl`, `tar`, and the PostgreSQL 17 client.
- `/usr/bin/node` must be Node.js 24 LTS; enable the repository-pinned pnpm
  version with Corepack.
- A reachable PostgreSQL database is still mandatory. It can temporarily run
  on the app CVM; moving `DATABASE_URL` to the private database server later
  does not change the application architecture.
- Build the artifact on Linux with Node 24. Do not deploy a macOS-built
  `node_modules`, because Prisma includes platform-specific engines.

Create the service identity and persistent directories once:

```bash
sudo useradd --system --home /var/lib/pheno-lab --shell /usr/sbin/nologin pheno
sudo install -d -m 0750 -o root -g pheno /srv/pheno-lab/releases /etc/pheno-lab
sudo install -d -m 0700 -o pheno -g pheno \
  /var/lib/pheno-lab/uploads /var/lib/pheno-lab/backups
```

## 2. Production configuration

Copy `deploy/pheno-lab.env.example` to `/etc/pheno-lab/pheno-lab.env`, replace
every placeholder, then lock it down:

```bash
sudo chown root:pheno /etc/pheno-lab/pheno-lab.env
sudo chmod 0640 /etc/pheno-lab/pheno-lab.env
```

The env file must remain valid shell assignment syntax. It is read by systemd
and sourced by the release script only to run `prisma migrate deploy`. Generate
independent random values for `SESSION_SECRET`, `INGEST_CRON_SECRET`, and
`HEALTHCHECK_TOKEN`; generate `AI_CREDENTIAL_KEY` with
`openssl rand -base64 32`. Do not reuse a database or COS credential. The
release process encrypts any legacy plaintext AI provider keys before switching
code.

For the first milestone keep:

```text
STORAGE_DRIVER=local
UPLOAD_DIR=/var/lib/pheno-lab/uploads
BACKUP_DIR=/var/lib/pheno-lab/backups
```

When the private COS bucket and CVM CAM role are ready, switch the file store
without changing application code:

```text
STORAGE_DRIVER=cos
COS_REGION=ap-guangzhou
COS_FILES_BUCKET=pheno-lab-prod-files-APPID
COS_AUTH_MODE=instance-role
COS_LEGACY_UPLOAD_DIR=/var/lib/pheno-lab/uploads
```

With `COS_LEGACY_UPLOAD_DIR` set, new writes and deletes use COS exclusively;
reads first use COS and only fall back to the retained local directory on a
miss. Keep the old directory read-only while the inventory/hash migration is
verified, then remove `COS_LEGACY_UPLOAD_DIR`. Do not enable this mode until the
bucket, least-privilege role, versioning, backup policy, and production data
inventory have been reviewed. Static COS credentials are available for
non-CVM environments, but the CVM instance role is the production default.
At cutover, enforce the fallback's read-only status with Unix permissions (for
example `root:pheno` and mode `0550`); the systemd unit keeps the path available
because the same unit must support the initial local-storage milestone.

## 3. Install services

```bash
sudo install -m 0644 deploy/systemd/pheno-lab.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/pheno-lab-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/pheno-lab-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pheno-lab.service pheno-lab-backup.timer
```

Copy `deploy/nginx/pheno-lab.conf.example` to `/etc/nginx/conf.d/pheno-lab.conf`,
replace the domain, certificate paths, and VPC readiness allowlist, then run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

The Next.js port `3457` must not be opened in the Tencent Cloud security group;
only Nginx talks to it over loopback.

## 4. Build and release

On a Linux build host with Node 24 and the test database available, first run
the CI checks, integration tests, and Playwright. Then create an immutable
artifact:

```bash
./deploy/scripts/build-release.sh /tmp/pheno-lab-20260824-001.tar.gz
```

Copy both the tarball and `.sha256` file to the CVM, then deploy:

```bash
sudo ./deploy/scripts/deploy-release.sh \
  /tmp/pheno-lab-20260824-001.tar.gz 20260824-001
```

The release script verifies the checksum, validates runtime configuration, runs
additive migrations, atomically switches `/srv/pheno-lab/current`, restarts systemd, and polls authenticated
readiness. If readiness fails, it points `current` back to the previous release
and restarts it. Applied database migrations are not downgraded; therefore every
migration must remain compatible with N-1 code (expand/contract is mandatory).

## 5. Verify and operate

```bash
sudo systemctl status pheno-lab --no-pager
sudo journalctl -u pheno-lab -n 100 --no-pager
curl -fsS http://127.0.0.1:3457/api/health/live
curl -fsS -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
  http://127.0.0.1:3457/api/health/ready
sudo systemctl start pheno-lab-backup.service
sudo systemctl list-timers pheno-lab-backup.timer
```

Before calling the database “backed up,” restore one `.sql.gz` file into a
separate `_test` database and verify login plus core reads. PostgreSQL backup
does not include `/var/lib/pheno-lab/uploads`; copy that directory with a
separate host-level backup until COS becomes the sole file store.

The repository-local work stops here. Provisioning Tencent Cloud resources,
installing these units on the CVM, supplying production secrets, importing the
real PostgreSQL database, moving existing objects, and exercising a real
release/rollback are operator-controlled deployment steps.

Do not delete old releases immediately. Keep at least the current and previous
known-good releases; failed releases are intentionally retained for diagnosis.
