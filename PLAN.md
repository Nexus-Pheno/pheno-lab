# Pheno Lab Data Platform — Project Plan

**Goal:** an internal web platform to capture perovskite solar cell experiments in a structured, database-backed way — replacing ad-hoc Excel sheets with a card-based experiment builder plus a mobile capture portal for lab technicians.

**Owner brand:** Pheno (per the Pheno/SZKL design system — `pheno.p2-data-grid` frame for the designer, "Live Lab Execution" archetype for the mobile portal).

---

## 1. Core concepts

| Concept | Meaning |
|---|---|
| **Experiment** | One experimental block. Holds the scientific-method narrative (observation, problem, hypothesis, conclusion), a process flow, a characterization plan, samples, labels/metadata. |
| **Process step** | One card in the flow: step type (washing, UVO, blade coat, anneal, sputter…), equipment (type + model + asset ID), process parameters, environment (glovebox N₂ / dry air / ambient, H₂O/O₂ ppm), material deposited (if any). |
| **Sample / batch** | An experiment produces N substrates (samples). Samples belong to **variation groups**; any step parameter can vary by group (e.g. anneal 100/120/140 °C for groups A/B/C). |
| **Run** | One execution of the experiment plan in the lab. The plan stores *planned* values; the run stores *actuals* per step per sample, captured by the technician. |
| **Characterization** | Planned measurements (J-V with scan direction, SEM, ellipsometry…) with instrument, settings, and which samples they apply to. Results = manually entered metrics (PCE, Voc, Jsc, FF, thickness…) + file attachments (CSV, images). No automatic parsing in v1. |
| **Preset** | Reusable saved item: equipment (with default params), process-step recipe, material/ink recipe, characterization protocol. Presets power the drag-and-drop / dropdown flow; anything new can be saved back as a preset. |

## 2. Two surfaces, one database

1. **Experiment Designer (desktop web)** — scientist builds the experiment: process library rail → card canvas → inspector panel for the selected step; scientific-method strip on top; variation matrix; "Send to lab" publishes a run.
   Mockup: `mockups/01-experiment-designer.html` / `.png`
2. **Capture Portal (mobile web / PWA)** — technician picks the active run, steps through the plan sample-by-sample: sees planned values, enters actuals (tolerance check against plan), confirms environment, attaches photo/voice/notes, "Confirm & next step". Chronological evidence strip of what was captured.
   Mockup: `mockups/02-mobile-capture.html` / `.png`

## 3. Data model (first cut)

- `experiments` (id, title, status draft/in-lab/complete, observation, problem, hypothesis, conclusion, created_by, timestamps)
- `samples` (experiment_id, code S1…Sn, variation_group)
- `process_steps` (experiment_id, position, step_type, equipment_id, environment, material_id nullable, notes)
- `step_parameters` (step_id, name, unit, planned_value) + `step_parameter_variations` (parameter_id, variation_group, value)
- `runs` (experiment_id, run_no, technician, status) and `step_executions` (run_id, step_id, sample_id, actual values JSON, environment_actual, captured_at, flags)
- `characterizations` (experiment_id, type, instrument_id, settings JSON, sample scope) and `characterization_results` (characterization_id, sample_id, metrics JSON, attachments)
- `equipment` (type, make, model, asset tag, location, default params), `materials` (name, category — perovskite ink / SAM / solvent / recipe, composition, lot), `presets` (kind, payload JSON, usage_count)
- `labels` / `entity_labels` for tagging, plus free-form metadata JSON on experiments and steps
- `attachments` (file store path, mime, linked entity)

Design principle: **plan vs. actual are separate records** — the designer writes the plan, the portal writes executions against it. Nothing is overwritten; deviations are visible.

## 4. Tech stack & deployment

- **App:** TypeScript, Next.js (designer UI + API routes), the mobile portal as a responsive route group of the same app (installable PWA).
- **DB:** PostgreSQL + Prisma. **Files:** local disk volume for attachments (S3-compatible later if needed).
- **Deployment:** Docker Compose on a lab-network machine (Mac mini / lab server); phones reach it over lab Wi-Fi. Simple email/password auth with roles (scientist, technician, admin).
- **Branding:** Pheno tokens (`#95CA00` signal green, graphite ink, neutral surfaces, 4/6/8 px radii, Inter + mono for data), official logo assets from the Pheno VI pack. Green stays a signal color, never a page wash.

## 5. Phases

**Phase 0 — Alignment (now):** mockups + this plan reviewed and approved; data-model sign-off.

**Phase 1 — Foundation & Designer (first working version):**
schema + migrations; equipment/material/preset libraries (CRUD); experiment builder — add/reorder step cards, inspector editing, presets, environment, materials; scientific-method fields; sample groups + per-step variations; labels/metadata; experiment list & detail views.

**Phase 2 — Designer polish:** drag-and-drop from the process library, duplicate/branch experiments as templates, preset usage stats ("commonly used"), search/filter across experiments, CSV/Excel export.

**Phase 3 — Capture Portal:** runs ("Send to lab"), mobile step-through capture with planned-vs-actual + tolerance hints, per-sample tracking, photo/note attachments, flagging issues, evidence timeline. Offline tolerance (queue + sync) if lab Wi-Fi is spotty.

**Phase 4 — Characterization & review:** characterization result entry (metrics + attachments), per-group result comparison view, conclusion unlock once data exists, basic dashboards (e.g. PCE by variation group).

## 6. Open questions

1. Equipment registry seed: do you have an existing equipment list (asset tags, models) we should import, or build it up via presets as people go?
2. Sample naming convention: free-form or enforced scheme (e.g. `EXP-2026-081-S4`)?
3. Roles: is scientist vs. technician separation enforced (technicians can't edit plans), or is everyone trusted equally in v1?
4. Roughly how many users / experiments per month? (Sizing only — the stack above covers any realistic lab volume.)
