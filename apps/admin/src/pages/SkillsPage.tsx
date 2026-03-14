import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  parseTagInput,
  safeJsonParse,
  safeJsonStringify,
  toTagInput,
  truncate,
} from "../lib/format";
import type { SkillDetailRecord, SkillRecord, SkillStepRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const EMPTY_STEP: SkillStepRecord = {
  instruction: "",
  order: 1,
  required: true,
  tool_hint: "",
};

function createEmptySkillForm() {
  return {
    description: "",
    display_name: "",
    input_schema: "{}",
    name: "",
    output_schema: "{}",
    required_services: "",
    scope_id: "system",
    scope_type: "company",
    steps: [{ ...EMPTY_STEP }],
    tags: "skill",
    trigger_when: "",
  };
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetailRecord | null>(null);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(createEmptySkillForm());

  async function loadSkills() {
    const data = await api.getSkills({
      q: search.trim() || undefined,
      scope_type: scopeFilter === "all" ? undefined : scopeFilter,
    });
    setSkills(data || []);
    if (!selectedSkillId && data?.[0]?.id) {
      setSelectedSkillId(data[0].id);
    }
  }

  useEffect(() => {
    void loadSkills().catch((nextError) =>
      setError(nextError instanceof Error ? nextError.message : "Failed to load skills.")
    );
  }, [search, scopeFilter]);

  useEffect(() => {
    if (!selectedSkillId) {
      setSelectedSkill(null);
      return;
    }

    setLoadingDetail(true);
    void api
      .getSkill(selectedSkillId)
      .then((detail) => {
        setSelectedSkill(detail || null);
        if (detail?.skill && !editingId) {
          setForm({
            description: detail.skill.description || "",
            display_name: detail.skill.display_name || "",
            input_schema: safeJsonStringify(detail.skill.input_schema),
            name: detail.skill.name || "",
            output_schema: safeJsonStringify(detail.skill.output_schema),
            required_services: toTagInput(detail.skill.required_services),
            scope_id: detail.skill.scope_id || "system",
            scope_type: detail.skill.scope_type || "company",
            steps:
              detail.skill.steps && detail.skill.steps.length > 0
                ? detail.skill.steps.map((step) => ({
                    ...step,
                    tool_hint: step.tool_hint || "",
                  }))
                : [{ ...EMPTY_STEP }],
            tags: toTagInput(detail.skill.tags),
            trigger_when: detail.skill.trigger_when || "",
          });
        }
      })
      .catch((nextError) =>
        setError(nextError instanceof Error ? nextError.message : "Failed to load skill detail.")
      )
      .finally(() => setLoadingDetail(false));
  }, [selectedSkillId, editingId]);

  const selectedSummary = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) || null,
    [selectedSkillId, skills]
  );

  function beginCreate() {
    setEditingId(null);
    setForm(createEmptySkillForm());
  }

  function beginEdit() {
    if (!selectedSkill) {
      return;
    }

    setEditingId(selectedSkill.skill.id);
  }

  function updateStep(index: number, patch: Partial<SkillStepRecord>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) =>
        stepIndex === index
          ? {
              ...step,
              ...patch,
            }
          : step
      ),
    }));
  }

  function addStep() {
    setForm((current) => ({
      ...current,
      steps: [
        ...current.steps,
        {
          ...EMPTY_STEP,
          order: current.steps.length + 1,
        },
      ],
    }));
  }

  function removeStep(index: number) {
    setForm((current) => ({
      ...current,
      steps: current.steps
        .filter((_, stepIndex) => stepIndex !== index)
        .map((step, stepIndex) => ({ ...step, order: stepIndex + 1 })),
    }));
  }

  async function saveSkill() {
    setSaving(true);
    setError(null);
    const payload = {
      description: form.description,
      display_name: form.display_name,
      input_schema: safeJsonParse(form.input_schema),
      name: form.name,
      output_schema: safeJsonParse(form.output_schema),
      required_services: parseTagInput(form.required_services),
      scope_id: form.scope_id,
      scope_type: form.scope_type,
      steps: form.steps.map((step, stepIndex) => ({
        instruction: step.instruction,
        order: stepIndex + 1,
        required: step.required,
        tool_hint: step.tool_hint || null,
      })),
      tags: parseTagInput(form.tags),
      trigger_when: form.trigger_when,
    };

    try {
      if (editingId) {
        await api.updateSkill(editingId, payload);
      } else {
        await api.createSkill(payload);
      }

      setEditingId(null);
      await loadSkills();
      if (selectedSkillId) {
        const detail = await api.getSkill(selectedSkillId);
        setSelectedSkill(detail || null);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save skill.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveSkill() {
    if (!selectedSkillId) {
      return;
    }

    setSaving(true);
    try {
      await api.deleteSkill(selectedSkillId);
      setSelectedSkillId(null);
      setSelectedSkill(null);
      await loadSkills();
      beginCreate();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to archive skill.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Skills</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Procedural skills stored through the admin control plane.
          </p>
        </div>
        <button onClick={beginCreate} style={shellStyles.button} type="button">
          Create Skill
        </button>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search skills..."
          style={{ ...shellStyles.input, flex: 1 }}
          value={search}
        />
        <select
          onChange={(event) => setScopeFilter(event.target.value)}
          style={{ ...shellStyles.input, minWidth: 180 }}
          value={scopeFilter}
        >
          <option value="all">All scopes</option>
          <option value="company">Company</option>
          <option value="project">Project</option>
          <option value="role">Role</option>
          <option value="task">Task</option>
        </select>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={shellStyles.card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Skill Library</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {skills.map((skill) => (
              <button
                key={skill.id}
                onClick={() => {
                  setSelectedSkillId(skill.id);
                  setEditingId(null);
                }}
                style={{
                  background: selectedSkillId === skill.id ? "#162032" : "transparent",
                  border: "1px solid #253247",
                  borderRadius: 10,
                  color: "inherit",
                  cursor: "pointer",
                  padding: 12,
                  textAlign: "left",
                }}
                type="button"
              >
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ color: "#f8fafc", fontWeight: 600 }}>{skill.display_name}</div>
                  <span style={statusChipStyle(skill.is_active ? "#22c55e" : "#6b7280")}>
                    v{skill.version}
                  </span>
                </div>
                <div style={shellStyles.muted}>{truncate(skill.description, 120)}</div>
                <div style={{ ...shellStyles.muted, marginTop: 6 }}>
                  {skill.scope_type}:{skill.scope_id} • used {skill.use_count} times
                </div>
              </button>
            ))}
            {skills.length === 0 && <div style={shellStyles.muted}>No skills found.</div>}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {editingId ? "Edit Skill" : "Skill Form"}
              </h3>
              {selectedSummary && !editingId && (
                <button
                  onClick={beginEdit}
                  style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }}
                  type="button"
                >
                  Edit Selected
                </button>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Name</label>
                  <input
                    onChange={(event) =>
                      setForm((current) => ({ ...current, name: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.name}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Display Name</label>
                  <input
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        display_name: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.display_name}
                  />
                </div>
              </div>

              <div>
                <label style={shellStyles.label}>Description</label>
                <textarea
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, width: "100%" }}
                  value={form.description}
                />
              </div>

              <div>
                <label style={shellStyles.label}>Trigger When</label>
                <textarea
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      trigger_when: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, minHeight: 90, width: "100%" }}
                  value={form.trigger_when}
                />
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "180px 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Scope Type</label>
                  <select
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        scope_type: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.scope_type}
                  >
                    <option value="company">company</option>
                    <option value="project">project</option>
                    <option value="role">role</option>
                    <option value="task">task</option>
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Scope ID</label>
                  <input
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        scope_id: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.scope_id}
                  />
                </div>
              </div>

              <div>
                <label style={shellStyles.label}>Steps</label>
                <div style={{ display: "grid", gap: 10 }}>
                  {form.steps.map((step, stepIndex) => (
                    <div
                      key={`step-${stepIndex}`}
                      style={{
                        background: "#0f1320",
                        border: "1px solid #293245",
                        borderRadius: 10,
                        padding: 12,
                      }}
                    >
                      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                        <strong>Step {stepIndex + 1}</strong>
                        {form.steps.length > 1 && (
                          <button
                            onClick={() => removeStep(stepIndex)}
                            style={{ ...shellStyles.button, ...shellStyles.buttonGhost, padding: "4px 8px" }}
                            type="button"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <textarea
                        onChange={(event) =>
                          updateStep(stepIndex, { instruction: event.target.value })
                        }
                        placeholder="Instruction"
                        style={{ ...shellStyles.textarea, minHeight: 80, width: "100%" }}
                        value={step.instruction}
                      />
                      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 140px", marginTop: 10 }}>
                        <input
                          onChange={(event) =>
                            updateStep(stepIndex, { tool_hint: event.target.value })
                          }
                          placeholder="Tool hint"
                          style={{ ...shellStyles.input, width: "100%" }}
                          value={step.tool_hint || ""}
                        />
                        <label style={{ alignItems: "center", display: "flex", gap: 8 }}>
                          <input
                            checked={step.required}
                            onChange={(event) =>
                              updateStep(stepIndex, { required: event.target.checked })
                            }
                            type="checkbox"
                          />
                          <span style={shellStyles.muted}>Required</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addStep}
                  style={{ ...shellStyles.button, ...shellStyles.buttonGhost, marginTop: 10 }}
                  type="button"
                >
                  Add Step
                </button>
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Required Services</label>
                  <input
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        required_services: event.target.value,
                      }))
                    }
                    placeholder="service-a, service-b"
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.required_services}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Tags</label>
                  <input
                    onChange={(event) =>
                      setForm((current) => ({ ...current, tags: event.target.value }))
                    }
                    placeholder="skill, billing"
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.tags}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Input Schema JSON</label>
                  <textarea
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        input_schema: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.textarea, minHeight: 140, width: "100%" }}
                    value={form.input_schema}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Output Schema JSON</label>
                  <textarea
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        output_schema: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.textarea, minHeight: 140, width: "100%" }}
                    value={form.output_schema}
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={saving}
                  onClick={() => void saveSkill()}
                  style={{ ...shellStyles.button, opacity: saving ? 0.7 : 1 }}
                  type="button"
                >
                  {saving ? "Saving..." : editingId ? "Save New Version" : "Create Skill"}
                </button>
                {editingId && (
                  <button
                    onClick={() => setEditingId(null)}
                    style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
                    type="button"
                  >
                    Cancel
                  </button>
                )}
                {selectedSkillId && (
                  <button
                    onClick={() => void archiveSkill()}
                    style={{ ...shellStyles.button, ...shellStyles.buttonDanger }}
                    type="button"
                  >
                    Archive
                  </button>
                )}
              </div>
            </div>
          </div>

          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Skill Detail</h3>
            {loadingDetail ? (
              <div style={shellStyles.muted}>Loading skill detail...</div>
            ) : !selectedSkill ? (
              <div style={shellStyles.muted}>Select a skill to inspect it.</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ color: "#f8fafc", fontSize: 17, fontWeight: 700 }}>
                      {selectedSkill.skill.display_name}
                    </div>
                    <div style={shellStyles.muted}>
                      {selectedSkill.skill.name} • {selectedSkill.skill.scope_type}:{selectedSkill.skill.scope_id}
                    </div>
                  </div>
                  <span style={statusChipStyle(selectedSkill.skill.is_active ? "#22c55e" : "#6b7280")}>
                    v{selectedSkill.skill.version}
                  </span>
                </div>
                <div style={{ color: "#d1d5db", lineHeight: 1.6 }}>
                  {selectedSkill.skill.description}
                </div>
                <div style={shellStyles.muted}>{selectedSkill.skill.trigger_when}</div>
                <div>
                  <strong>Steps</strong>
                  <ol style={{ marginBottom: 0, marginTop: 8, paddingLeft: 20 }}>
                    {selectedSkill.skill.steps.map((step) => (
                      <li key={`${selectedSkill.skill.id}-${step.order}`} style={{ marginBottom: 6 }}>
                        <span>{step.instruction}</span>
                        {step.tool_hint && (
                          <span style={{ ...shellStyles.muted, marginLeft: 8 }}>
                            [{step.tool_hint}]
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {selectedSkill.skill.tags.map((tag) => (
                    <span key={`${selectedSkill.skill.id}-${tag}`} style={statusChipStyle("#64748b")}>
                      {tag}
                    </span>
                  ))}
                </div>
                <div style={shellStyles.muted}>
                  Used {selectedSkill.skill.use_count} times • last used{" "}
                  {selectedSkill.skill.last_used_at || "never"}
                </div>
                <div>
                  <strong>Version History</strong>
                  <div style={{ marginTop: 8 }}>
                    {selectedSkill.versions.map((version) => (
                      <div
                        key={`version-${version.id}`}
                        style={{
                          alignItems: "center",
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 6,
                        }}
                      >
                        <span style={shellStyles.muted}>
                          v{version.version} • {version.id.slice(0, 8)}
                        </span>
                        <span style={shellStyles.muted}>{version.updated_at}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

