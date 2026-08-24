# Pheno Bridge — instrument uploader

A small Windows program that runs on each J-V simulator PC. It watches the
folder the instrument software writes into and uploads every new measurement
file to the Pheno Lab server, where it is parsed and attached to the right
sample automatically.

It needs **no administrator rights**: it installs into `%LOCALAPPDATA%\PhenoBridge`
and starts itself from the user's Startup folder.

## The two rigs

| | 小太阳 | 大太阳 |
|---|---|---|
| Software | GiantForce "IV Measurement System" | LIGHTSKY `Liv-2020` (LabVIEW), LSS-200 |
| PC | `DESKTOP-MGMS5H0` | `XXGF` |
| Saving | automatic, every pixel | **manual** — operator ticks rows → Save |
| Watch folder | `D:\IV Measurement System\Data` | `D:\PhenoUpload` (to be created) |
| Agent setting | `GIANTFORCE_IV` | `LIGHTSKY_LIV` |

## Build

```bash
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o pheno-bridge.exe .
```

No dependencies outside the Go standard library, so nothing to vendor and
nothing unusual for antivirus to object to.

## Install on a lab PC

1. Register the rig on the server and copy the key it prints (shown once):

   ```bash
   pnpm exec tsx scripts/register-instrument.ts "小太阳" GIANTFORCE_IV
   pnpm exec tsx scripts/register-instrument.ts "大太阳" LIGHTSKY_LIV
   ```

2. Copy `pheno-bridge.exe` to the lab PC (USB stick is fine) and run:

   ```
   pheno-bridge.exe install
   ```

   It asks for the server URL, the API key, which rig it is, and the folder to
   watch, then installs itself and enables auto-start.

3. Confirm it works:

   ```
   pheno-bridge.exe test
   ```

   This checks the watch folder exists and that the server accepts the key.

Then log out and back in (or run `pheno-bridge.exe run`) and it is live. A
minimised console window shows what it is doing; the same lines go to
`%LOCALAPPDATA%\PhenoBridge\logs\bridge.log`.

### Only new files are uploaded

By default, installation records the current time and ignores everything older,
so installing on the 小太阳 PC does **not** upload its 667 folders of history.
Back-filling is a separate, deliberate job (`--include-history` exists but do not
use it without a plan for how the old data maps to experiments).

## What operators must do

**Type the Pheno sample ID into the instrument software.**

- 小太阳 → the **Serial NO.** field: `2026-001-1-4-S1`
  A pixel suffix is fine and encouraged: `2026-001-1-4-S1-2`. Pixels are recorded
  but the lab reports one number per sample, so the platform shows the best pixel.
- 大太阳 → the **Sample name** field: `2026-001-1-4-S1`
  The software appends the scan direction itself (`…-Rev` / `…-For`).

Anything that does not start with a valid experiment code is still uploaded and
kept — it lands in the unmatched queue with an explanation rather than being
thrown away — but it will not appear on the experiment until someone fixes it.

**On 大太阳 only:** because that software never auto-saves, at the end of every
session tick **Select All** and **Save** into `D:\PhenoUpload`. Anything not
saved is invisible to the platform.

## Commands

| | |
|---|---|
| `pheno-bridge.exe install` | configure, install, enable auto-start |
| `pheno-bridge.exe run` | run in the foreground (what Startup launches) |
| `pheno-bridge.exe test` | check the folder and the server connection |
| `pheno-bridge.exe status` | list the most recent uploads |
| `pheno-bridge.exe uninstall` | remove the auto-start entry |

## How it behaves

- **Waits for files to settle.** A file is only uploaded once it has stopped
  changing for `stableSeconds` (default 5), so a CSV still being written is never
  grabbed half-finished.
- **Survives the server being down.** Files are never marked done until the
  server accepts them; it retries with a widening backoff and uploads oldest
  first, so a weekend offline just catches up on Monday.
- **Never uploads twice.** Both sides deduplicate on the SHA-256 of the contents.
- **Sends raw files, parses nothing.** All parsing is server-side, so a parser
  fix is a web deploy — never another trip to the lab.
- **Uploads the screenshot too.** The `.jpg` GiantForce saves beside each CSV is
  attached to the matching scan automatically.
