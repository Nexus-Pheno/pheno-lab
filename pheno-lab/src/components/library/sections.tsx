"use client";

import { useRef, useState } from "react";
import type { Equipment, LabEnvironment, Location, Process, ProcessKind } from "@prisma/client";
import type { ParamDef } from "@/lib/library";
import { PROCESS_ICONS } from "@/lib/library";
import { paramDefs } from "@/lib/types";
import {
  createProcess, updateProcess, createLocation, updateLocation,
  createEquipment, updateEquipment,
  createEnvironment, updateEnvironment,
} from "@/lib/actions/library";
import { Icon, FieldLabel, inputCls, selectCls } from "@/components/ui";
import { useT, useTerm } from "@/lib/i18n/LanguageProvider";
import { LibrarySection } from "./Collapsible";

const ADD_LOCATION = "__add_location__";

// Shared editor for parameter/condition definition rows.
function DefRows({
  defs,
  onChange,
  nameLabel,
}: {
  defs: ParamDef[];
  onChange: (defs: ParamDef[]) => void;
  nameLabel: string;
}) {
  const t = useT();
  const patch = (i: number, p: Partial<ParamDef>) =>
    onChange(defs.map((d, j) => (j === i ? { ...d, ...p } : d)));
  return (
    <div>
      <div className="grid grid-cols-[1fr_90px_110px_auto] gap-1.5 text-[10px] font-bold uppercase text-muted mb-1">
        <span>{nameLabel} {t("lib.defName")}</span>
        <span>{t("lib.defUnit")}</span>
        <span>{t("lib.defDefault")}</span>
        <span />
      </div>
      <div className="space-y-1.5">
        {defs.map((d, i) => (
          <div key={i} className="grid grid-cols-[1fr_90px_110px_auto] gap-1.5 items-center">
            <input className="border border-line rounded-[3px] px-2 py-1 text-[12px]" value={d.name} placeholder={`${nameLabel} name, e.g. Speed`}
              onChange={(e) => patch(i, { name: e.target.value })} />
            <input className="border border-line rounded-[3px] px-2 py-1 text-[12px] text-muted" value={d.unit} placeholder="mm/s"
              onChange={(e) => patch(i, { unit: e.target.value })} />
            <input className="mono border border-line rounded-[3px] px-2 py-1 text-[12px]" value={d.defaultValue} placeholder="5"
              onChange={(e) => patch(i, { defaultValue: e.target.value })} />
            <button onClick={() => onChange(defs.filter((_, j) => j !== i))} className="text-muted hover:text-danger p-0.5">
              <Icon name="X" size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...defs, { name: "", unit: "", defaultValue: "" }])}
        className="mt-1.5 text-[11px] font-semibold text-brand-deep flex items-center gap-1"
      >
        <Icon name="Plus" size={11} /> {t("lib.add")} {nameLabel.toLowerCase()}
      </button>
    </div>
  );
}

// ---------------- Equipment editor ----------------

type EquipmentForm = {
  name: string; make: string; model: string; assetTag: string;
  locationId: string | null; photoPath: string; parameters: ParamDef[];
};

const emptyEquipment: EquipmentForm = {
  name: "", make: "", model: "", assetTag: "", locationId: null, photoPath: "", parameters: [],
};

function EquipmentEditor({
  value,
  locations,
  canAddLocation,
  onSave,
  onCancel,
  saveLabel,
}: {
  value: EquipmentForm;
  locations: Location[];
  canAddLocation: boolean;
  onSave: (form: EquipmentForm) => Promise<void>;
  onCancel: () => void;
  saveLabel: string;
}) {
  const t = useT();
  const [form, setForm] = useState<EquipmentForm>(value);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const patch = (p: Partial<EquipmentForm>) => setForm((f) => ({ ...f, ...p }));

  const uploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (json.fileName) patch({ photoPath: json.fileName });
      else alert(json.error ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="p-3.5 space-y-3 bg-subtle border-t border-line">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="col-span-2">
          <FieldLabel>{t("lib.equipmentName")}</FieldLabel>
          <input className={inputCls} placeholder="e.g. Hotplate — IKA C-MAG HS 7"
            value={form.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div>
          <FieldLabel>{t("lib.manufacturer")}</FieldLabel>
          <input className={inputCls} placeholder="e.g. IKA" value={form.make} onChange={(e) => patch({ make: e.target.value })} />
        </div>
        <div>
          <FieldLabel>{t("lib.modelNumber")}</FieldLabel>
          <input className={inputCls} placeholder="e.g. C-MAG HS 7" value={form.model} onChange={(e) => patch({ model: e.target.value })} />
        </div>
        <div>
          <FieldLabel>{t("lib.assetTag")}</FieldLabel>
          <input className={inputCls} placeholder="e.g. HP-02" value={form.assetTag} onChange={(e) => patch({ assetTag: e.target.value })} />
        </div>
        <div>
          <FieldLabel>{t("lib.location")}</FieldLabel>
          <select
            className={selectCls}
            value={form.locationId ?? ""}
            onChange={async (e) => {
              if (e.target.value === ADD_LOCATION) {
                const name = prompt("New location name:");
                if (name?.trim()) {
                  const location = await createLocation(name);
                  patch({ locationId: location.id });
                }
                return;
              }
              patch({ locationId: e.target.value || null });
            }}
          >
            <option value="">{t("lib.noLocation")}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
            {canAddLocation && <option value={ADD_LOCATION}>{t("lib.addLocation")}</option>}
          </select>
        </div>
        <div className="col-span-2">
          <FieldLabel>{t("lib.photo")}</FieldLabel>
          <div className="flex items-center gap-2.5">
            {form.photoPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/files/${form.photoPath}`} alt="Equipment" className="h-12 w-12 object-cover rounded-[4px] border border-line" />
            ) : (
              <div className="h-12 w-12 rounded-[4px] border border-dashed border-line flex items-center justify-center text-muted">
                <Icon name="Camera" size={16} />
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="text-[11px] font-semibold border border-line rounded-[4px] px-3 py-1.5 bg-surface hover:bg-subtle disabled:opacity-50">
              {uploading ? t("lib.uploading") : form.photoPath ? t("lib.replacePhoto") : t("lib.uploadPhoto")}
            </button>
            {form.photoPath && (
              <button onClick={() => patch({ photoPath: "" })} className="text-[11px] text-muted hover:text-danger">
                {t("lib.removePhoto")}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="bg-surface border border-line rounded-[4px] p-3">
        <FieldLabel>{t("lib.machineParams")}</FieldLabel>
        <p className="text-[11px] text-muted mb-2">
          {t("lib.machineParamsHint")}
        </p>
        <DefRows defs={form.parameters} onChange={(parameters) => patch({ parameters })} nameLabel={t("insp.parameter")} />
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="border border-line rounded-[4px] px-4 py-1.5 text-[12px] font-semibold hover:bg-surface">
          {t("lib.cancel")}
        </button>
        <button
          disabled={busy || !form.name.trim()}
          onClick={async () => {
            setBusy(true);
            await onSave({ ...form, parameters: form.parameters.filter((p) => p.name.trim()) });
            setBusy(false);
          }}
          className="bg-ink text-white rounded-[4px] px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------- Process parameters ----------------
//
// The per-process parameter definitions: every new step of the process
// starts with these, each tagged "process" in the database.

function ProcessParamsEditor({ process, canEdit }: { process: Process; canEdit: boolean }) {
  const t = useT();
  const tt = useTerm();
  const [editing, setEditing] = useState(false);
  const [defs, setDefs] = useState<ParamDef[]>(() => paramDefs(process.parameters));
  const [busy, setBusy] = useState(false);
  const saved = paramDefs(process.parameters);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <FieldLabel>{t("lib.paramsFor")} {tt(process.name)}</FieldLabel>
        {canEdit && (
          <button
            onClick={() => { setDefs(paramDefs(process.parameters)); setEditing((v) => !v); }}
            className="text-[11px] font-semibold text-brand-deep"
          >
            {t(editing ? "lib.close" : "lib.edit")}
          </button>
        )}
      </div>
      {!editing ? (
        <div className="flex flex-wrap gap-1">
          {saved.length === 0 && <p className="text-[11px] text-muted">—</p>}
          {saved.map((d) => (
            <span key={d.name} className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal">
              {tt(d.name)}{d.unit ? ` (${d.unit})` : ""}
              {d.defaultValue && <span className="mono text-muted"> = {d.defaultValue}</span>}
            </span>
          ))}
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-[4px] p-3 space-y-2.5">
          <DefRows defs={defs} onChange={setDefs} nameLabel={t("insp.parameter")} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="text-[11.5px] font-semibold text-muted px-2 py-1">
              {t("insp.cancel")}
            </button>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await updateProcess(process.id, { parameters: defs.filter((d) => d.name.trim()) });
                setBusy(false);
                setEditing(false);
              }}
              className="bg-ink text-white rounded-[4px] px-3 py-1 text-[11.5px] font-semibold disabled:opacity-50"
            >
              {t("lib.saveChanges")}
            </button>
          </div>
        </div>
      )}
      <p className="text-[10px] text-muted mt-1.5">{t("lib.paramsHint")}</p>
    </div>
  );
}

// ---------------- Process library ----------------

export function ProcessLibrary({
  processes,
  equipment,
  locations,
  canEdit,
  canEditEquipment,
  canAddLocation,
  layers,
}: {
  processes: Process[];
  equipment: Equipment[];
  locations: Location[];
  layers: { code: string; name: string }[];
  canEdit: boolean;
  canEditEquipment: boolean;
  canAddLocation: boolean;
}) {
  const t = useT();
  const tt = useTerm();
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingEq, setEditingEq] = useState<string | null>(null); // equipment id or "new"
  const [addingProcess, setAddingProcess] = useState<ProcessKind | null>(null);
  const [newProcess, setNewProcess] = useState({ name: "", icon: "Wrench" });
  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? "";

  const renderProcess = (p: Process) => {
    const eqs = equipment.filter((e) => e.processId === p.id);
    const open = openId === p.id;
    return (
      <div key={p.id} className={"border-b border-line last:border-0 " + (p.archived ? "opacity-45" : "")}>
        <button
          onClick={() => { setOpenId(open ? null : p.id); setEditingEq(null); }}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-subtle text-left"
        >
          <Icon name={p.icon} size={15} className="text-charcoal shrink-0" />
          <span className="text-[13px] font-semibold flex-1">{tt(p.name)}</span>
          {p.defaultLayer && (
            <span className="text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-[3px] bg-ink/5 border border-ink/15 text-charcoal">
              {layers.find((l) => l.code === p.defaultLayer)?.name ?? p.defaultLayer}
            </span>
          )}
          <span className="text-[11px] text-muted">{eqs.length} {t("lib.equipmentCount")}</span>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} className="text-muted" />
        </button>

        {open && (
          <div className="border-t border-line bg-subtle/50 px-3.5 py-3 space-y-4">
            {/* Which device layer this process usually builds */}
            <div>
              <FieldLabel>{t("lib.defaultLayer")}</FieldLabel>
              <select
                className={selectCls + " max-w-xs"}
                disabled={!canEdit}
                defaultValue={p.defaultLayer}
                onChange={(e) => updateProcess(p.id, { defaultLayer: e.target.value })}
              >
                <option value="">{t("insp.noLayer")}</option>
                {layers.map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </div>

            {/* Process-level parameters */}
            <ProcessParamsEditor process={p} canEdit={canEdit} />

            {/* Equipment under this process */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <FieldLabel>{t("lib.equipmentFor")} {tt(p.name)}</FieldLabel>
                {canEditEquipment && editingEq === null && (
                  <button onClick={() => setEditingEq("new")} className="text-[11px] font-semibold text-brand-deep flex items-center gap-1">
                    <Icon name="Plus" size={11} /> {t("lib.addEquipment")}
                  </button>
                )}
              </div>
              <div className="bg-surface border border-line rounded-[4px] divide-y divide-line">
                {eqs.length === 0 && editingEq !== "new" && (
                  <p className="px-3 py-3 text-[12px] text-muted">{t("lib.noEquipment")}</p>
                )}
                {eqs.map((e) => (
                  <div key={e.id} className={e.archived ? "opacity-45" : ""}>
                    <div className="flex items-center gap-2.5 px-3 py-2">
                      {e.photoPath ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/files/${e.photoPath}`} alt="" className="h-9 w-9 object-cover rounded-[3px] border border-line" />
                      ) : (
                        <div className="h-9 w-9 rounded-[3px] border border-line bg-subtle flex items-center justify-center text-muted">
                          <Icon name="Camera" size={13} />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium truncate">{e.name}</div>
                        <div className="text-[10.5px] text-muted truncate">
                          {[e.make, e.model].filter(Boolean).join(" · ")}
                          {e.assetTag && <span className="mono"> · {e.assetTag}</span>}
                          {e.locationId && ` · ${locationName(e.locationId)}`}
                        </div>
                      </div>
                      <div className="hidden md:flex flex-wrap gap-1 max-w-64 justify-end">
                        {paramDefs(e.parameters).slice(0, 4).map((d) => (
                          <span key={d.name} className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal">
                            {tt(d.name)}{d.unit ? ` (${d.unit})` : ""}
                          </span>
                        ))}
                        {paramDefs(e.parameters).length > 4 && (
                          <span className="text-[10px] text-muted">+{paramDefs(e.parameters).length - 4}</span>
                        )}
                      </div>
                      {canEditEquipment && (
                        <div className="flex gap-2.5 shrink-0">
                          <button onClick={() => setEditingEq(editingEq === e.id ? null : e.id)} className="text-[11px] font-semibold text-brand-deep">
                            {editingEq === e.id ? t("lib.close") : t("lib.edit")}
                          </button>
                          <button onClick={() => updateEquipment(e.id, { archived: !e.archived })} className="text-[11px] font-semibold text-muted hover:text-ink">
                            {e.archived ? t("lib.restore") : t("lib.archive")}
                          </button>
                        </div>
                      )}
                    </div>
                    {editingEq === e.id && (
                      <EquipmentEditor
                        canAddLocation={canAddLocation}
                        value={{
                          name: e.name, make: e.make, model: e.model, assetTag: e.assetTag,
                          locationId: e.locationId, photoPath: e.photoPath, parameters: paramDefs(e.parameters),
                        }}
                        locations={locations}
                        saveLabel={t("lib.saveChanges")}
                        onCancel={() => setEditingEq(null)}
                        onSave={async (form) => { await updateEquipment(e.id, form); setEditingEq(null); }}
                      />
                    )}
                  </div>
                ))}
                {editingEq === "new" && (
                  <EquipmentEditor
                        canAddLocation={canAddLocation}
                    value={emptyEquipment}
                    locations={locations}
                    saveLabel={t("lib.addEquipment")}
                    onCancel={() => setEditingEq(null)}
                    onSave={async (form) => { await createEquipment({ ...form, processId: p.id }); setEditingEq(null); }}
                  />
                )}
              </div>
            </div>

            {canEdit && (
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    const name = prompt(t("lib.renameProcess") + ":", p.name);
                    if (name?.trim()) updateProcess(p.id, { name: name.trim() });
                  }}
                  className="text-[11px] font-semibold text-muted hover:text-ink"
                >
                  {t("lib.renameProcess")}
                </button>
                <button
                  onClick={() => updateProcess(p.id, { archived: !p.archived })}
                  className="text-[11px] font-semibold text-muted hover:text-danger"
                >
                  {p.archived ? t("lib.restoreProcess") : t("lib.archiveProcess")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const addProcessForm = (kind: ProcessKind) => (
    <div className="flex flex-wrap items-end gap-2 p-3 border-t border-line bg-subtle">
      <div className="flex-1 min-w-52">
        <FieldLabel>{t("lib.processName")}</FieldLabel>
        <input className={inputCls} placeholder={kind === "PROCESSING" ? "e.g. Electrodeposition" : "e.g. UV-Vis"} autoFocus
          value={newProcess.name} onChange={(e) => setNewProcess((f) => ({ ...f, name: e.target.value }))} />
      </div>
      <div>
        <FieldLabel>{t("lib.icon")}</FieldLabel>
        <select className={selectCls} value={newProcess.icon} onChange={(e) => setNewProcess((f) => ({ ...f, icon: e.target.value }))}>
          {PROCESS_ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
      </div>
      <button
        disabled={!newProcess.name.trim()}
        onClick={async () => {
          await createProcess({ name: newProcess.name.trim(), kind, icon: newProcess.icon });
          setNewProcess({ name: "", icon: "Wrench" });
          setAddingProcess(null);
        }}
        className="bg-ink text-white rounded-[4px] px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
      >
        {t("lib.addProcess")}
      </button>
      <button onClick={() => setAddingProcess(null)} className="border border-line rounded-[4px] px-3 py-1.5 text-[12px] font-semibold bg-surface">
        {t("lib.cancel")}
      </button>
    </div>
  );

  const group = (kind: ProcessKind, title: string, subtitle: string) => (
    <LibrarySection
      title={title}
      subtitle={subtitle}
      icon={kind === "PROCESSING" ? "Workflow" : "Microscope"}
      count={processes.filter((p) => p.kind === kind && !p.archived).length}
    >
      <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
        {processes.filter((p) => p.kind === kind).map(renderProcess)}
        {canEdit && (addingProcess === kind ? addProcessForm(kind) : (
          <div className="p-3 border-t border-line bg-subtle">
            <button onClick={() => setAddingProcess(kind)} className="text-[12px] font-semibold text-brand-deep flex items-center gap-1">
              <Icon name="Plus" size={13} /> {t("lib.addProcess")}
            </button>
          </div>
        ))}
      </div>
    </LibrarySection>
  );

  return (
    <>
      {group("PROCESSING", t("lib.processes"), t("lib.processesHint"))}
      {group("CHARACTERIZATION", t("lib.characterization"), t("lib.charHint"))}
    </>
  );
}

// ---------------- Locations ----------------

export function LocationSection({ locations, canEdit }: { locations: Location[]; canEdit: boolean }) {
  const t = useT();
  const [name, setName] = useState("");
  return (
    <LibrarySection
      title={t("lib.locations")}
      subtitle={t("lib.locationsHint")}
      icon="MapPin"
      count={locations.filter((l) => !l.archived).length}
    >
      <div className="bg-surface border border-line rounded-[6px] p-3">
        <div className="flex flex-wrap gap-1.5">
          {locations.map((l) => (
            <span key={l.id} className={"text-[12px] px-2.5 py-1 rounded-[4px] border border-line bg-subtle flex items-center gap-1.5 " + (l.archived ? "opacity-45" : "")}>
              <Icon name="MapPin" size={12} className="text-muted" />
              {l.name}
              {canEdit && (
                <button onClick={() => updateLocation(l.id, { archived: !l.archived })} className="text-muted hover:text-danger" title={l.archived ? "Restore" : "Archive"}>
                  <Icon name={l.archived ? "RotateCcw" : "X"} size={11} />
                </button>
              )}
            </span>
          ))}
          {locations.length === 0 && <span className="text-[12px] text-muted">{t("lib.noLocations")}</span>}
        </div>
        {canEdit && (
          <div className="flex gap-2 mt-2.5">
            <input className={inputCls + " max-w-xs"} placeholder={t("lib.newLocationPh")}
              value={name} onChange={(e) => setName(e.target.value)} />
            <button
              disabled={!name.trim()}
              onClick={async () => { await createLocation(name); setName(""); }}
              className="bg-ink text-white rounded-[4px] px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            >
              {t("lib.addLocationBtn")}
            </button>
          </div>
        )}
      </div>
    </LibrarySection>
  );
}

// ---------------- Environments ----------------

type EnvironmentForm = { name: string; conditions: ParamDef[] };

function EnvironmentEditorForm({
  value,
  onSave,
  onCancel,
  saveLabel,
}: {
  value: EnvironmentForm;
  onSave: (form: EnvironmentForm) => Promise<void>;
  onCancel: () => void;
  saveLabel: string;
}) {
  const t = useT();
  const [form, setForm] = useState<EnvironmentForm>(value);
  const [busy, setBusy] = useState(false);

  return (
    <div className="p-3.5 space-y-3 bg-subtle border-t border-line">
      <div className="max-w-sm">
        <FieldLabel>{t("lib.envName")}</FieldLabel>
        <input className={inputCls} placeholder="e.g. Glovebox N₂ or Clean room"
          value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </div>
      <div className="bg-surface border border-line rounded-[4px] p-3">
        <FieldLabel>{t("lib.conditions")}</FieldLabel>
        <p className="text-[11px] text-muted mb-2">
          {t("lib.conditionsHint")}
        </p>
        <DefRows defs={form.conditions} onChange={(conditions) => setForm((f) => ({ ...f, conditions }))} nameLabel={t("insp.setting")} />
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="border border-line rounded-[4px] px-4 py-1.5 text-[12px] font-semibold hover:bg-surface">
          {t("lib.cancel")}
        </button>
        <button
          disabled={busy || !form.name.trim()}
          onClick={async () => {
            setBusy(true);
            await onSave({ ...form, conditions: form.conditions.filter((c) => c.name.trim()) });
            setBusy(false);
          }}
          className="bg-ink text-white rounded-[4px] px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

export function EnvironmentSection({ environments, canEdit }: { environments: LabEnvironment[]; canEdit: boolean }) {
  const t = useT();
  const tt = useTerm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <LibrarySection
      title={t("lib.environments")}
      subtitle={t("lib.environmentsHint")}
      icon="Thermometer"
      count={environments.filter((e) => !e.archived).length}
    >
      <div className="bg-surface border border-line rounded-[6px] overflow-hidden">
        {environments.map((env) => (
          <div key={env.id} className={"border-b border-line last:border-0 " + (env.archived ? "opacity-45" : "")}>
            <div className="flex items-center gap-2.5 px-3.5 py-2.5">
              <Icon name="Thermometer" size={14} className="text-charcoal shrink-0" />
              <span className="text-[13px] font-semibold">{tt(env.name)}</span>
              <div className="flex flex-wrap gap-1 flex-1">
                {paramDefs(env.conditions).map((c) => (
                  <span key={c.name} className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-subtle border border-line text-charcoal">
                    {tt(c.name)}{c.unit ? ` (${c.unit})` : ""}
                  </span>
                ))}
              </div>
              {canEdit && (
                <div className="flex gap-2.5 shrink-0">
                  <button onClick={() => { setEditingId(editingId === env.id ? null : env.id); setAdding(false); }} className="text-[11px] font-semibold text-brand-deep">
                    {editingId === env.id ? t("lib.close") : t("lib.edit")}
                  </button>
                  <button onClick={() => updateEnvironment(env.id, { archived: !env.archived })} className="text-[11px] font-semibold text-muted hover:text-ink">
                    {env.archived ? t("lib.restore") : t("lib.archive")}
                  </button>
                </div>
              )}
            </div>
            {editingId === env.id && (
              <EnvironmentEditorForm
                value={{ name: env.name, conditions: paramDefs(env.conditions) }}
                saveLabel={t("lib.saveChanges")}
                onCancel={() => setEditingId(null)}
                onSave={async (form) => { await updateEnvironment(env.id, form); setEditingId(null); }}
              />
            )}
          </div>
        ))}
        {canEdit && (
          adding ? (
            <EnvironmentEditorForm
              value={{ name: "", conditions: [] }}
              saveLabel={t("lib.addEnvironment")}
              onCancel={() => setAdding(false)}
              onSave={async (form) => { await createEnvironment(form); setAdding(false); }}
            />
          ) : (
            <div className="p-3 border-t border-line bg-subtle">
              <button onClick={() => { setAdding(true); setEditingId(null); }} className="text-[12px] font-semibold text-brand-deep flex items-center gap-1">
                <Icon name="Plus" size={13} /> {t("lib.addEnvironment")}
              </button>
            </div>
          )
        )}
      </div>
    </LibrarySection>
  );
}
