# Handoff — equipment attachments, production deploy, equipment ingest

Written 2026-08-26. Authorised by Michael: deploy directly, Louis's sign-off **not**
required for this change. Read `pheno-lab/deploy/README.md` first — it is the only
deployment procedure; do not invent another.

## Goal, in order

1. Build attachment support so equipment can carry its original spec sheets.
2. Deploy `main` (plus that change) to `lab.szkl.com`.
3. Stage 12 new equipment records with PDFs attached, for Michael to approve at
   `https://lab.szkl.com/ingest`.

## Verified state (2026-08-26)

| Thing | State |
|---|---|
| local `main` | in sync with GitHub — `0 ahead, 0 behind` |
| GitHub | `Nexus-Pheno/pheno-lab`, `main` at `038d3c9` |
| server `/srv/pheno-lab/source` | at `c0f7258` — **two merges behind** |
| `pheno-lab.service` | active |
| SSH | works, see below |
| sudo on CVM | passwordless |

### SSH — the key already exists on this Mac

```bash
ssh -i ~/.ssh/pheno_lab_app_cvm -o IdentitiesOnly=yes ubuntu@101.32.44.37
```

A plain `ssh ubuntu@101.32.44.37` FAILS with "Permission denied (publickey)" because
the default key set does not include this one. That is not a missing grant — always
pass `-i ~/.ssh/pheno_lab_app_cvm -o IdentitiesOnly=yes`. Port 22 is open from this
network; `/srv/pheno-lab/source` is owned by `pheno`, so use `sudo` to read it.

`readlink -f /srv/pheno-lab/current` returned EMPTY. Work out how `current` is wired
before flipping it — do not assume it is a symlink to a release directory.

## Step 1 — attachment support (do locally, verify, then commit)

`Equipment` currently has only `photoPath String` — a single photo. There is no way to
attach a document. Add, expand-only so the running build stays compatible:

```prisma
model Attachment {
  // ... existing fields
  equipmentId String?
  equipment   Equipment? @relation(fields: [equipmentId], references: [id], onDelete: Cascade)
}

model Equipment {
  // ... existing fields
  attachments Attachment[]
}
```

Then:
- extend `EquipmentDraft` with `documents: { fileName, storedPath, mime, size }[]`
- attach them in the EQUIPMENT branch of `publishIngestItem`
- upload via the existing `POST /api/upload`; serve via `GET /api/files/[...key]`
  (production writes to private COS, not local disk — check `modules/` for the
  storage adapter before assuming a path)
- show a document list on the equipment card in the library

Expand-only matters: the old code must keep working if the deploy is rolled back.

## Step 2 — deploy

Use ONLY the documented scripts:

```bash
./deploy/scripts/build-release.sh "/tmp/pheno-lab-$RELEASE_ID.tar.gz"
sudo ./deploy/scripts/deploy-release.sh ...   # see deploy/README.md §4
```

Notes:
- The production `DATABASE_URL` is never stored locally; the README prompts for it
  interactively (`read -rsp`). Do not paste it anywhere persistent.
- Take a database backup before the migration. §4.6 requires backup/restore evidence
  for any data change.
- Readiness is `/api/health/ready` (checks PostgreSQL + COS). If it fails within
  ~60s the script points `current` back at the previous release.
- **Do not commit `pheno-bridge/*.go` or `scripts/register-instrument.ts`** — those
  are another agent's in-flight instrument-bridge work. Deploy `main` as it stands.

## Step 3 — ingest the equipment

Source: `~/Downloads/设备(1)(1)/` — 28 files. Nine duplicate equipment already in the
library; **12 are new** and fill the exact gaps left when seed machines were archived
(24 experiment steps currently read "no machine").

`设备清单.xlsx` is the register: 27 rows.
- **Use columns B (设备名称), H (规格型号), I (供应商名称)** — accurate.
- **IGNORE column G (设备描述)** — machine-generated from photos and frequently wrong:
  the glovebox is described as a plant-growth chamber, the solar simulator as
  "professional audio equipment", the SEM as a precision balance. Michael was asked
  and did not confirm keeping it; recommendation is to drop it and build records from
  the spec PDFs instead. Confirm before ingesting that column.

New machines → process mapping:

| Machine | Model | Process |
|---|---|---|
| Laurell 匀胶机 / 雷博 匀胶机 | EZ4 | Spin coating |
| 热台 ×2 (易拓 ETOOL) | ET series | Thermal anneal |
| 众能 狭缝涂布机 | ZNB-300 | Slot-die coating |
| 迪塔美克 狭缝涂布机 | — | Slot-die coating |
| 刮涂 — 慧诺 | KTQ-300 | Blade coating |
| 刮涂 — Zehntner | ZUA2000.150 | Blade coating |
| 刮涂 — LEBO | PF-200H | Blade coating |
| 光谱椭偏仪 | SE-VM-L | Ellipsometry |
| KLA 台阶仪 | P-7 | Profilometry |
| Rigaku XRD | MiniFlex600 | XRD |
| 大族 激光划刻机 | — | Laser scribing |
| 恒辉 半自动层压机 | — | Encapsulation |
| 台湾曌嘉 大太阳 + QE | LST-QE | J-V / EQE |
| 老化设备 广州晶合 | — | stability (may need a new process) |
| CH Instruments 电化学工作站 | — | electrochemistry (may need a new process) |

Stage with `scripts/stage-ingest.js --file <json>`; `EquipmentDraft.processName` must
match an existing Process by name or publishing throws.

## Tooling already built (reuse, do not rewrite)

- `scripts/survey-historical.py` — xlsx reader that expands merged cells, reverses
  Excel's date-serial corruption, and normalises sample names. `sheets_of` /
  `grid_of` / `aliases` are reusable for any spreadsheet here.
- `pdftotext -layout` (poppler installed) — plain `pdftotext` silently returns
  nothing for several Chinese CID-encoded datasheets. For scanned PDFs with no text
  layer, `pdftoppm -png` then read the image.

## Gotchas that cost time in this session

- A `const` export in a `"use server"` file breaks the build — put constants in a
  plain module (see `src/lib/ai/presets.ts`).
- Never `updateMany({where:{archived:false}})` — Michael approves ingest items while
  an agent works, so "currently active" can include records published seconds ago. A
  blanket equipment archive caught 8 just-published real machines.
- The Tutti browser tool hangs intermittently; verify against the database instead of
  retrying the browser.
- Cloud and local are SEPARATE datasets. Local has ~1,265 staged items from earlier
  sessions; cloud had 1. Another agent is running data ingestion on the cloud — check
  before staging anything that might overlap.
