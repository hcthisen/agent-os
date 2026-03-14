import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, parseTagInput, safeJsonParse, safeJsonStringify, slugify, toTagInput, truncate } from "../lib/format";
import type { AgentRecord, ProjectRecord, SkillDetailRecord, SkillRecord, SkillStepRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const EMPTY_STEP: SkillStepRecord = { instruction: "", order: 1, required: true, tool_hint: "" };

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

function buildFormPreviewSkill(form: ReturnType<typeof createEmptySkillForm>): SkillRecord {
  return {
    created_at: "",
    description: form.description.trim(),
    display_name: form.display_name.trim() || form.name.trim() || "Untitled Skill",
    id: "preview",
    input_schema: safeJsonParse(form.input_schema),
    is_active: true,
    last_used_at: null,
    name: slugify(form.name.trim() || form.display_name.trim() || "skill-preview"),
    output_schema: safeJsonParse(form.output_schema),
    required_services: parseTagInput(form.required_services),
    scope_id: form.scope_id.trim() || "system",
    scope_type: form.scope_type,
    steps: form.steps.map((step, index) => ({ instruction: step.instruction.trim(), order: index + 1, required: step.required, tool_hint: step.tool_hint?.trim() || null })).filter((step) => step.instruction),
    tags: parseTagInput(form.tags),
    trigger_when: form.trigger_when.trim(),
    updated_at: "",
    use_count: 0,
    version: 1,
  };
}

function buildTaskBriefingPreview(skill: SkillRecord): string {
  const steps = skill.steps.length ? skill.steps.map((step) => `${step.order}. ${step.instruction}`) : ["1. Review the skill definition in memory before acting."];
  return `# Task Briefing\n\n## Simulation Mode\nThis preview task runs in simulation-only mode. Report the intended procedure without mutating runtime or external systems.\n\n{\n  "task": {\n    "title": "Preview task using ${skill.display_name}",\n    "objective": "${skill.trigger_when || "Use the shared skill when the trigger applies."}",\n    "simulation_only": true\n  }\n}\n\n## Relevant Skills\n\n### Skill: ${skill.display_name}\nTrigger: ${skill.trigger_when || "Not specified"}\nSteps:\n${steps.join("\n")}`;
}

function parseImportedSkillText(raw: string): Partial<ReturnType<typeof createEmptySkillForm>> {
  const text = raw.trim();
  if (!text) throw new Error("Paste a procedure description to import.");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const readField = (prefixes: string[]) => {
    const line = lines.find((entry) => prefixes.some((prefix) => entry.toLowerCase().startsWith(prefix)));
    if (!line) return "";
    const [, ...rest] = line.split(":");
    return rest.join(":").trim();
  };
  const explicitSteps = lines.map((line) => line.match(/^\d+[.)]\s+(.*)$/)?.[1]?.trim() || line.match(/^[-*]\s+(.*)$/)?.[1]?.trim() || "").filter(Boolean);
  const fallbackSteps = explicitSteps.length ? explicitSteps : text.split(/(?:\.\s+|\n+)/).map((part) => part.trim()).filter((part) => part.length > 18).slice(0, 8);
  const titleCandidate = readField(["name:", "skill:", "title:"]) || lines[0].replace(/^remember:\s*/i, "").replace(/^always:\s*/i, "");
  const name = slugify(titleCandidate || "shared-skill");
  const displayName = readField(["display name:"]) || titleCandidate;
  const description = readField(["description:"]) || lines.filter((line) => !/^(name|skill|title|display name|description|trigger|trigger when|scope type|scope id|tags|required services|steps):/i.test(line) && !/^\d+[.)]\s+/.test(line) && !/^[-*]\s+/.test(line)).join(" ").trim();
  return {
    description,
    display_name: displayName,
    name,
    required_services: readField(["required services:", "services:"]),
    scope_id: readField(["scope id:"]) || "system",
    scope_type: readField(["scope type:"]).toLowerCase() || "company",
    steps: fallbackSteps.length ? fallbackSteps.map((instruction, index) => ({ instruction, order: index + 1, required: true, tool_hint: "" })) : [{ ...EMPTY_STEP }],
    tags: readField(["tags:"]) || "skill",
    trigger_when: readField(["trigger when:", "trigger:"]) || description || `Use the ${displayName || name} procedure when the operator's request matches.`,
  };
}

function getAgentLabel(agent: AgentRecord | null | undefined): string {
  if (!agent) return "";
  return agent.role_profile?.display_name || agent.name || agent.role_id;
}

function deriveSuggestedTestRole(skill: Pick<SkillRecord, "scope_id" | "scope_type"> | null, agents: AgentRecord[]): string {
  if (skill?.scope_type === "role" && agents.some((agent) => agent.role_id === skill.scope_id)) return skill.scope_id;
  if (agents.some((agent) => agent.role_id === "builder")) return "builder";
  return agents[0]?.role_id || "";
}

export function SkillsPage({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetailRecord | null>(null);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(createEmptySkillForm());
  const [importText, setImportText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testRoleId, setTestRoleId] = useState("");
  const [testProjectId, setTestProjectId] = useState("");
  const [lastTestTaskId, setLastTestTaskId] = useState<string | null>(null);

  async function loadSkills() {
    const data = await api.getSkills({ q: search.trim() || undefined, scope_type: scopeFilter === "all" ? undefined : scopeFilter });
    setSkills(data || []);
    if (!selectedSkillId && data?.[0]?.id) setSelectedSkillId(data[0].id);
  }

  useEffect(() => {
    void Promise.all([api.getAgents(), api.getProjects()])
      .then(([agentsData, projectsData]) => {
        setAgents(agentsData || []);
        setProjects(projectsData || []);
        setTestRoleId(deriveSuggestedTestRole(null, agentsData || []));
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Failed to load skill references."));
  }, []);

  useEffect(() => {
    void loadSkills().catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Failed to load skills."));
  }, [search, scopeFilter]);

  useEffect(() => {
    if (!selectedSkillId) {
      setSelectedSkill(null);
      return;
    }
    setLoadingDetail(true);
    void api.getSkill(selectedSkillId).then((detail) => {
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
          steps: detail.skill.steps?.length ? detail.skill.steps.map((step) => ({ ...step, tool_hint: step.tool_hint || "" })) : [{ ...EMPTY_STEP }],
          tags: toTagInput(detail.skill.tags),
          trigger_when: detail.skill.trigger_when || "",
        });
        setTestRoleId((current) => current || deriveSuggestedTestRole(detail.skill, agents));
      }
    }).catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Failed to load skill detail.")).finally(() => setLoadingDetail(false));
  }, [agents, editingId, selectedSkillId]);

  const selectedSummary = useMemo(() => skills.find((skill) => skill.id === selectedSkillId) || null, [selectedSkillId, skills]);
  const previewSkill = useMemo(() => buildFormPreviewSkill(form), [form]);
  const taskBriefingPreview = useMemo(() => buildTaskBriefingPreview(previewSkill), [previewSkill]);

  function beginCreate() {
    setEditingId(null);
    setForm(createEmptySkillForm());
    setImportText("");
    setLastTestTaskId(null);
    setTestRoleId(deriveSuggestedTestRole(null, agents));
  }

  function beginEdit() {
    if (selectedSkill) setEditingId(selectedSkill.skill.id);
  }

  function updateStep(index: number, patch: Partial<SkillStepRecord>) {
    setForm((current) => ({ ...current, steps: current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step) }));
  }

  function addStep() {
    setForm((current) => ({ ...current, steps: [...current.steps, { ...EMPTY_STEP, order: current.steps.length + 1 }] }));
  }

  function removeStep(index: number) {
    setForm((current) => ({ ...current, steps: current.steps.filter((_, stepIndex) => stepIndex !== index).map((step, stepIndex) => ({ ...step, order: stepIndex + 1 })) }));
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
      steps: form.steps.map((step, stepIndex) => ({ instruction: step.instruction, order: stepIndex + 1, required: step.required, tool_hint: step.tool_hint || null })),
      tags: parseTagInput(form.tags),
      trigger_when: form.trigger_when,
    };
    try {
      const savedSkill = editingId ? await api.updateSkill(editingId, payload) : await api.createSkill(payload);
      setEditingId(null);
      setSelectedSkillId(savedSkill?.id || null);
      await loadSkills();
      if (savedSkill?.id) {
        const detail = await api.getSkill(savedSkill.id);
        setSelectedSkill(detail || null);
        setTestRoleId(deriveSuggestedTestRole(detail?.skill || null, agents));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save skill.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveSkill() {
    if (!selectedSkillId) return;
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

  function applyImportedText() {
    try {
      const imported = parseImportedSkillText(importText);
      setForm((current) => ({ ...current, ...imported }));
      setImportOpen(false);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to import skill text.");
    }
  }

  async function createTestTask() {
    setTesting(true);
    setError(null);
    try {
      const activeSkill = previewSkill;
      const roleId = testRoleId || deriveSuggestedTestRole(activeSkill, agents);
      if (!roleId) throw new Error("Select an agent before creating a test task.");
      const created = await api.createTask({
        acceptance_criteria: [
          "Confirm whether the shared skill appears in TASK_BRIEFING.",
          "Summarize how the skill would be applied for the request.",
          "Stay in simulation mode and avoid durable runtime or external mutations.",
        ],
        assigned_role: roleId,
        objective: [`Safely validate the shared skill \"${activeSkill.display_name}\".`, activeSkill.trigger_when ? `Trigger pattern: ${activeSkill.trigger_when}` : null, "This is a simulation-only task. Report your intended procedure only."].filter(Boolean).join(" "),
        priority: "normal",
        project_id: testProjectId || null,
        simulation_only: true,
        title: `Test skill: ${activeSkill.display_name}`,
      });
      setLastTestTaskId(created?.id || null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create test task.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Skills</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>Procedural skills stored through the admin control plane.</p>
        </div>
        <button onClick={beginCreate} style={shellStyles.button} type="button">Create Skill</button>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}
      {lastTestTaskId && (
        <div style={{ ...shellStyles.card, alignItems: "center", display: "flex", gap: 10, marginBottom: 12, padding: 12 }}>
          <span style={shellStyles.muted}>Created simulation test task {lastTestTaskId.slice(0, 8)}.</span>
          {onOpenTask && (
            <button onClick={() => onOpenTask(lastTestTaskId)} style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }} type="button">
              Open Task
            </button>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input onChange={(event) => setSearch(event.target.value)} placeholder="Search skills..." style={{ ...shellStyles.input, flex: 1 }} value={search} />
        <select onChange={(event) => setScopeFilter(event.target.value)} style={{ ...shellStyles.input, minWidth: 180 }} value={scopeFilter}>
          <option value="all">All scopes</option>
          <option value="company">Company</option>
          <option value="project">Project</option>
          <option value="customer">Customer</option>
          <option value="department">Department</option>
          <option value="role">Agent</option>
          <option value="task">Task</option>
        </select>
      </div>

      {importOpen && (
        <div style={{ ...shellStyles.card, marginBottom: 16 }}>
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Import From Text</h3>
              <p style={{ ...shellStyles.muted, margin: "6px 0 0" }}>Paste a natural-language procedure or structured notes. The form will be populated from numbered lines, bullets, and common field labels.</p>
            </div>
            <button onClick={() => setImportOpen(false)} style={{ ...shellStyles.button, ...shellStyles.buttonGhost }} type="button">Close</button>
          </div>
          <textarea
            onChange={(event) => setImportText(event.target.value)}
            placeholder={"Name: Invoice Follow-up\nTrigger: When a customer asks about unpaid invoices\n1. Look up the invoice in the billing system\n2. Confirm due date and owner\n3. Draft the response and include finance@company.com"}
            style={{ ...shellStyles.textarea, minHeight: 180, width: "100%" }}
            value={importText}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={applyImportedText} style={shellStyles.button} type="button">Apply Import</button>
          </div>
        </div>
      )}

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
                style={{ background: selectedSkillId === skill.id ? "#162032" : "transparent", border: "1px solid #253247", borderRadius: 10, color: "inherit", cursor: "pointer", padding: 12, textAlign: "left" }}
                type="button"
              >
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ color: "#f8fafc", fontWeight: 600 }}>{skill.display_name}</div>
                  <span style={statusChipStyle(skill.is_active ? "#22c55e" : "#6b7280")}>v{skill.version}</span>
                </div>
                <div style={shellStyles.muted}>{truncate(skill.description, 120)}</div>
                <div style={{ ...shellStyles.muted, marginTop: 6 }}>{skill.scope_type}:{skill.scope_id} - used {skill.use_count} times</div>
              </button>
            ))}
            {skills.length === 0 && <div style={shellStyles.muted}>No skills found.</div>}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{editingId ? "Edit Skill" : "Skill Form"}</h3>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setImportOpen((current) => !current)} style={{ ...shellStyles.button, ...shellStyles.buttonGhost }} type="button">Import From Text</button>
                {selectedSummary && !editingId && (
                  <button onClick={beginEdit} style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }} type="button">Edit Selected</button>
                )}
              </div>
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Name</label>
                  <input onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} style={{ ...shellStyles.input, width: "100%" }} value={form.name} />
                </div>
                <div>
                  <label style={shellStyles.label}>Display Name</label>
                  <input onChange={(event) => setForm((current) => ({ ...current, display_name: event.target.value }))} style={{ ...shellStyles.input, width: "100%" }} value={form.display_name} />
                </div>
              </div>

              <div>
                <label style={shellStyles.label}>Description</label>
                <textarea onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} style={{ ...shellStyles.textarea, width: "100%" }} value={form.description} />
              </div>

              <div>
                <label style={shellStyles.label}>Trigger When</label>
                <textarea onChange={(event) => setForm((current) => ({ ...current, trigger_when: event.target.value }))} style={{ ...shellStyles.textarea, minHeight: 90, width: "100%" }} value={form.trigger_when} />
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "180px 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Scope Type</label>
                  <select onChange={(event) => setForm((current) => ({ ...current, scope_type: event.target.value }))} style={{ ...shellStyles.input, width: "100%" }} value={form.scope_type}>
                    <option value="company">company</option>
                    <option value="project">project</option>
                    <option value="customer">customer</option>
                    <option value="department">department</option>
                    <option value="role">agent</option>
                    <option value="task">task</option>
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Scope ID</label>
                  <input onChange={(event) => setForm((current) => ({ ...current, scope_id: event.target.value }))} style={{ ...shellStyles.input, width: "100%" }} value={form.scope_id} />
                </div>
              </div>

              <div>
                <label style={shellStyles.label}>Steps</label>
                <div style={{ display: "grid", gap: 10 }}>
                  {form.steps.map((step, stepIndex) => (
                    <div key={`step-${stepIndex}`} style={{ background: "#0f1320", border: "1px solid #293245", borderRadius: 10, padding: 12 }}>
                      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                        <strong>Step {stepIndex + 1}</strong>
                        {form.steps.length > 1 && (
                          <button onClick={() => removeStep(stepIndex)} style={{ ...shellStyles.button, ...shellStyles.buttonGhost, padding: "4px 8px" }} type="button">Remove</button>
                        )}
                      </div>
                      <textarea onChange={(event) => updateStep(stepIndex, { instruction: event.target.value })} placeholder="Instruction" style={{ ...shellStyles.textarea, minHeight: 80, width: "100%" }} value={step.instruction} />
                      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 140px", marginTop: 10 }}>
                        <input onChange={(event) => updateStep(stepIndex, { tool_hint: event.target.value })} placeholder="Tool hint" style={{ ...shellStyles.input, width: "100%" }} value={step.tool_hint || ""} />
                        <label style={{ alignItems: "center", display: "flex", gap: 8 }}>
                          <input checked={step.required} onChange={(event) => updateStep(stepIndex, { required: event.target.checked })} type="checkbox" />
                          <span style={shellStyles.muted}>Required</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={addStep} style={{ ...shellStyles.button, ...shellStyles.buttonGhost, marginTop: 10 }} type="button">Add Step</button>
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Required Services</label>
                  <input onChange={(event) => setForm((current) => ({ ...current, required_services: event.target.value }))} placeholder="service-a, service-b" style={{ ...shellStyles.input, width: "100%" }} value={form.required_services} />
                </div>
                <div>
                  <label style={shellStyles.label}>Tags</label>
                  <input onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))} placeholder="skill, billing" style={{ ...shellStyles.input, width: "100%" }} value={form.tags} />
                </div>
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Input Schema JSON</label>
                  <textarea onChange={(event) => setForm((current) => ({ ...current, input_schema: event.target.value }))} style={{ ...shellStyles.textarea, minHeight: 140, width: "100%" }} value={form.input_schema} />
                </div>
                <div>
                  <label style={shellStyles.label}>Output Schema JSON</label>
                  <textarea onChange={(event) => setForm((current) => ({ ...current, output_schema: event.target.value }))} style={{ ...shellStyles.textarea, minHeight: 140, width: "100%" }} value={form.output_schema} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={saving} onClick={() => void saveSkill()} style={{ ...shellStyles.button, opacity: saving ? 0.7 : 1 }} type="button">{saving ? "Saving..." : editingId ? "Save New Version" : "Create Skill"}</button>
                {editingId && <button onClick={() => setEditingId(null)} style={{ ...shellStyles.button, ...shellStyles.buttonGhost }} type="button">Cancel</button>}
                {selectedSkillId && <button onClick={() => void archiveSkill()} style={{ ...shellStyles.button, ...shellStyles.buttonDanger }} type="button">Archive</button>}
              </div>
            </div>
          </div>

          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Task Briefing Preview</h3>
            <pre style={{ background: "#0b1020", border: "1px solid #253247", borderRadius: 10, color: "#dbeafe", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, margin: 0, overflowX: "auto", padding: 14, whiteSpace: "pre-wrap" }}>{taskBriefingPreview}</pre>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
              <div>
                <label style={shellStyles.label}>Test Agent</label>
                <select onChange={(event) => setTestRoleId(event.target.value)} style={{ ...shellStyles.input, width: "100%" }} value={testRoleId}>
                  <option value="">Select agent</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.role_id}>{getAgentLabel(agent)}</option>)}
                </select>
              </div>
              <div>
                <label style={shellStyles.label}>Test Project</label>
                <select onChange={(event) => setTestProjectId(event.target.value)} style={{ ...shellStyles.input, width: "100%" }} value={testProjectId}>
                  <option value="">No project</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.display_name}</option>)}
                </select>
              </div>
            </div>
            <button disabled={testing} onClick={() => void createTestTask()} style={{ ...shellStyles.button, marginTop: 12, opacity: testing ? 0.7 : 1 }} type="button">{testing ? "Creating Test Task..." : "Create Simulation Test Task"}</button>
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
                    <div style={{ color: "#f8fafc", fontSize: 17, fontWeight: 700 }}>{selectedSkill.skill.display_name}</div>
                    <div style={shellStyles.muted}>{selectedSkill.skill.name} - {selectedSkill.skill.scope_type}:{selectedSkill.skill.scope_id}</div>
                  </div>
                  <span style={statusChipStyle(selectedSkill.skill.is_active ? "#22c55e" : "#6b7280")}>v{selectedSkill.skill.version}</span>
                </div>
                <div style={{ color: "#d1d5db", lineHeight: 1.6 }}>{selectedSkill.skill.description}</div>
                <div style={shellStyles.muted}>{selectedSkill.skill.trigger_when}</div>
                <div>
                  <strong>Steps</strong>
                  <ol style={{ marginBottom: 0, marginTop: 8, paddingLeft: 20 }}>
                    {selectedSkill.skill.steps.map((step) => (
                      <li key={`${selectedSkill.skill.id}-${step.order}`} style={{ marginBottom: 6 }}>
                        <span>{step.instruction}</span>
                        {step.tool_hint && <span style={{ ...shellStyles.muted, marginLeft: 8 }}>[{step.tool_hint}]</span>}
                      </li>
                    ))}
                  </ol>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {selectedSkill.skill.tags.map((tag) => <span key={`${selectedSkill.skill.id}-${tag}`} style={statusChipStyle("#64748b")}>{tag}</span>)}
                </div>
                <div style={shellStyles.muted}>Used {selectedSkill.skill.use_count} times - last used {selectedSkill.skill.last_used_at || "never"}</div>
                <div>
                  <strong>Version History</strong>
                  <div style={{ marginTop: 8 }}>
                    {selectedSkill.versions.map((version) => (
                      <div key={`version-${version.id}`} style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={shellStyles.muted}>v{version.version} - {version.id.slice(0, 8)}</span>
                        <span style={shellStyles.muted}>{formatDateTime(version.updated_at)}</span>
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
