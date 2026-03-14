import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, parseTagInput, toTagInput } from "../lib/format";
import type { MemoryRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const MEMORY_PAGE_SIZE = 50;

const LAYER_COLORS: Record<string, string> = {
  episodic: "#3b82f6",
  procedural: "#a855f7",
  semantic: "#22c55e",
};

const EMPTY_FORM = {
  confidence: 1,
  content: "",
  layer: "semantic",
  scope_id: "system",
  scope_type: "company",
  subject: "",
  tags: "",
};

function estimateImportChunks(content: string, splitMode: "paragraph" | "sentence"): number {
  const normalized = content.trim();
  if (!normalized) {
    return 0;
  }

  const chunks =
    splitMode === "sentence"
      ? normalized
          .split(/(?<=[.!?])\s+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length >= 12)
      : normalized
          .split(/\n\s*\n+/)
          .map((entry) => entry.replace(/\s+/g, " ").trim())
          .filter((entry) => entry.length >= 20);

  return chunks.length;
}

export function MemoryStudioPage() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");
  const [scopeTypeFilter, setScopeTypeFilter] = useState("all");
  const [mode, setMode] = useState<"all" | "knowledge">("all");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMode, setImportMode] = useState<"paragraph" | "sentence">("paragraph");
  const [importSubjectPrefix, setImportSubjectPrefix] = useState("");
  const [lastImportCount, setLastImportCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const selectedMemory = useMemo(
    () => memories.find((memory) => memory.id === selectedMemoryId) || null,
    [memories, selectedMemoryId]
  );

  async function loadMemories(options?: { append?: boolean }) {
    const before =
      options?.append && memories.length > 0
        ? memories[memories.length - 1].created_at
        : undefined;
    const data = await api.getMemoriesPage({
      before,
      layer: layerFilter === "all" ? undefined : layerFilter,
      limit: MEMORY_PAGE_SIZE,
      mode,
      query: search.trim() || undefined,
      scope_type: scopeTypeFilter === "all" ? undefined : scopeTypeFilter,
    });
    const nextMemories = data || [];

    setMemories((current) =>
      options?.append ? [...current, ...nextMemories] : nextMemories
    );
    setHasMore(nextMemories.length === MEMORY_PAGE_SIZE);
  }

  useEffect(() => {
    void loadMemories().catch((nextError) =>
      setError(nextError instanceof Error ? nextError.message : "Failed to load memories.")
    );
  }, [layerFilter, mode, scopeTypeFilter, search]);

  useEffect(() => {
    if (!selectedMemory) {
      return;
    }

    setForm({
      confidence: selectedMemory.confidence ?? 1,
      content: selectedMemory.content || "",
      layer: selectedMemory.layer || "semantic",
      scope_id: selectedMemory.scope_id || "system",
      scope_type: selectedMemory.scope_type || "company",
      subject: selectedMemory.subject || "",
      tags: toTagInput(selectedMemory.tags),
    });
  }, [selectedMemoryId]);

  async function saveMemory() {
    setSaving(true);
    try {
      const payload = {
        confidence: Number(form.confidence) || 1,
        content: form.content,
        layer: form.layer,
        scope_id: form.scope_id,
        scope_type: form.scope_type,
        subject: form.subject,
        tags: parseTagInput(form.tags),
      };

      if (creating || !selectedMemoryId) {
        const created = await api.createMemory(payload);
        setCreating(false);
        await loadMemories();
        setSelectedMemoryId(created.id);
      } else {
        await api.updateMemory(selectedMemoryId, payload);
        await loadMemories();
      }
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save memory.");
    } finally {
      setSaving(false);
    }
  }

  async function expireSelectedMemory() {
    if (!selectedMemoryId) {
      return;
    }

    await api.expireMemory(selectedMemoryId);
    setSelectedMemoryId(null);
    await loadMemories();
  }

  async function loadMoreMemories() {
    setLoadingMore(true);
    try {
      await loadMemories({ append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  function beginCreate() {
    setCreating(true);
    setSelectedMemoryId(null);
    setForm(EMPTY_FORM);
  }

  async function runBulkImport() {
    setImporting(true);
    try {
      const result = await api.bulkImportMemories({
        confidence: Number(form.confidence) || 1,
        content: importText,
        scope_id: form.scope_id || "system",
        scope_type: form.scope_type || "company",
        split_mode: importMode,
        subject_prefix: importSubjectPrefix,
        tags: parseTagInput(form.tags),
      });
      setLastImportCount(result.count || 0);
      setImportText("");
      setImportSubjectPrefix("");
      setImportOpen(false);
      setMode("knowledge");
      await loadMemories();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to import memories.");
    } finally {
      setImporting(false);
    }
  }

  const importPreviewCount = estimateImportChunks(importText, importMode);

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Memory</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Search, filter, create, edit, and switch into knowledge-base mode.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setImportOpen((current) => !current)}
            style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }}
            type="button"
          >
            Bulk Import
          </button>
          <button onClick={beginCreate} style={shellStyles.button} type="button">
            Create Memory
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}
      {lastImportCount !== null && (
        <div style={{ ...shellStyles.card, marginBottom: 12, padding: 12 }}>
          Imported {lastImportCount} semantic {lastImportCount === 1 ? "memory" : "memories"} into the knowledge base.
        </div>
      )}

      {importOpen && (
        <div style={{ ...shellStyles.card, marginBottom: 16 }}>
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Bulk Knowledge Import</h3>
              <p style={{ ...shellStyles.muted, margin: "6px 0 0" }}>
                Paste a document and split it into semantic memories by paragraph or sentence.
              </p>
            </div>
            <span style={shellStyles.muted}>
              Estimated entries: {importPreviewCount}
            </span>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "180px 1fr" }}>
              <div>
                <label style={shellStyles.label}>Split Mode</label>
                <select
                  onChange={(event) => setImportMode(event.target.value as "paragraph" | "sentence")}
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={importMode}
                >
                  <option value="paragraph">paragraph</option>
                  <option value="sentence">sentence</option>
                </select>
              </div>
              <div>
                <label style={shellStyles.label}>Subject Prefix</label>
                <input
                  onChange={(event) => setImportSubjectPrefix(event.target.value)}
                  placeholder="Optional label, e.g. Invoice policy"
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={importSubjectPrefix}
                />
              </div>
            </div>
            <textarea
              onChange={(event) => setImportText(event.target.value)}
              placeholder={"Paste a knowledge document here.\n\nSeparate facts with blank lines for paragraph mode, or switch to sentence mode for finer splitting."}
              style={{ ...shellStyles.textarea, minHeight: 220, width: "100%" }}
              value={importText}
            />
            <div style={{ ...shellStyles.muted }}>
              Import scope: {form.scope_type}:{form.scope_id || "system"} • tags: {form.tags || "none"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={importing || importPreviewCount === 0}
                onClick={() => void runBulkImport()}
                style={{ ...shellStyles.button, opacity: importing || importPreviewCount === 0 ? 0.7 : 1 }}
                type="button"
              >
                {importing ? "Importing..." : "Import Memories"}
              </button>
              <button
                onClick={() => setImportOpen(false)}
                style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
                type="button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 180px 180px auto", marginBottom: 16 }}>
        <input
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by subject..."
          style={{ ...shellStyles.input, width: "100%" }}
          value={search}
        />
        <select
          onChange={(event) => setLayerFilter(event.target.value)}
          style={{ ...shellStyles.input, width: "100%" }}
          value={layerFilter}
        >
          <option value="all">All layers</option>
          <option value="episodic">episodic</option>
          <option value="semantic">semantic</option>
          <option value="procedural">procedural</option>
        </select>
        <select
          onChange={(event) => setScopeTypeFilter(event.target.value)}
          style={{ ...shellStyles.input, width: "100%" }}
          value={scopeTypeFilter}
        >
          <option value="all">All scopes</option>
          <option value="company">company</option>
          <option value="project">project</option>
          <option value="customer">customer</option>
          <option value="department">department</option>
          <option value="role">role</option>
          <option value="task">task</option>
        </select>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setMode("all")}
            style={{
              ...shellStyles.button,
              ...(mode === "all" ? {} : shellStyles.buttonGhost),
            }}
            type="button"
          >
            All Memories
          </button>
          <button
            onClick={() => setMode("knowledge")}
            style={{
              ...shellStyles.button,
              ...(mode === "knowledge" ? {} : shellStyles.buttonGhost),
            }}
            type="button"
          >
            Knowledge Base
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={shellStyles.card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
            {mode === "knowledge" ? "Knowledge Base" : "Memory Index"}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {memories.map((memory) => (
              <button
                key={memory.id}
                onClick={() => {
                  setCreating(false);
                  setSelectedMemoryId(memory.id);
                }}
                style={{
                  background: selectedMemoryId === memory.id ? "#162032" : "transparent",
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
                  <div style={{ color: "#f8fafc", fontWeight: 600 }}>{memory.subject}</div>
                  <span style={statusChipStyle(LAYER_COLORS[memory.layer] || "#64748b")}>
                    {memory.layer}
                  </span>
                </div>
                <div style={shellStyles.muted}>
                  {memory.scope_type}:{memory.scope_id}
                </div>
                <div style={{ ...shellStyles.muted, marginTop: 4 }}>
                  {formatDateTime(memory.created_at)}
                </div>
              </button>
            ))}
            {memories.length === 0 && <div style={shellStyles.muted}>No memories found.</div>}
          </div>
          {hasMore && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
              <button
                disabled={loadingMore}
                onClick={() => void loadMoreMemories()}
                style={{ ...shellStyles.button, opacity: loadingMore ? 0.7 : 1 }}
                type="button"
              >
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {creating || !selectedMemory ? "Create Memory" : "Memory Editor"}
              </h3>
              {selectedMemory && !creating && (
                <button
                  onClick={() => void expireSelectedMemory()}
                  style={{ ...shellStyles.button, ...shellStyles.buttonDanger }}
                  type="button"
                >
                  Expire
                </button>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "160px 1fr 160px" }}>
                <div>
                  <label style={shellStyles.label}>Layer</label>
                  <select
                    onChange={(event) =>
                      setForm((current) => ({ ...current, layer: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.layer}
                  >
                    <option value="episodic">episodic</option>
                    <option value="semantic">semantic</option>
                    <option value="procedural">procedural</option>
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Subject</label>
                  <input
                    onChange={(event) =>
                      setForm((current) => ({ ...current, subject: event.target.value }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={form.subject}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Confidence</label>
                  <input
                    max={1}
                    min={0}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        confidence: Number(event.target.value),
                      }))
                    }
                    step={0.1}
                    style={{ ...shellStyles.input, width: "100%" }}
                    type="number"
                    value={form.confidence}
                  />
                </div>
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
                    <option value="customer">customer</option>
                    <option value="department">department</option>
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
                <label style={shellStyles.label}>Content</label>
                <textarea
                  onChange={(event) =>
                    setForm((current) => ({ ...current, content: event.target.value }))
                  }
                  style={{ ...shellStyles.textarea, width: "100%" }}
                  value={form.content}
                />
              </div>
              <div>
                <label style={shellStyles.label}>Tags</label>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, tags: event.target.value }))
                  }
                  placeholder="operator_taught, preference"
                  style={{ ...shellStyles.input, width: "100%" }}
                  value={form.tags}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={saving}
                  onClick={() => void saveMemory()}
                  style={{ ...shellStyles.button, opacity: saving ? 0.7 : 1 }}
                  type="button"
                >
                  {saving ? "Saving..." : creating || !selectedMemory ? "Create Memory" : "Save Memory"}
                </button>
              </div>
            </div>
          </div>

          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Selected Memory</h3>
            {!selectedMemory ? (
              <div style={shellStyles.muted}>Select a memory to inspect it.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                  <span style={statusChipStyle(LAYER_COLORS[selectedMemory.layer] || "#64748b")}>
                    {selectedMemory.layer}
                  </span>
                  <span style={shellStyles.muted}>
                    {selectedMemory.scope_type}:{selectedMemory.scope_id}
                  </span>
                </div>
                <div style={{ color: "#f8fafc", fontSize: 17, fontWeight: 700 }}>
                  {selectedMemory.subject}
                </div>
                <div style={{ color: "#d1d5db", lineHeight: 1.6 }}>
                  {selectedMemory.content}
                </div>
                <div style={shellStyles.muted}>
                  Created {formatDateTime(selectedMemory.created_at)} • confidence {selectedMemory.confidence}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {selectedMemory.tags.map((tag) => (
                    <span key={`${selectedMemory.id}-${tag}`} style={statusChipStyle("#64748b")}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
