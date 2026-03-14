import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { ScheduleRecord, ServiceEntryRecord } from "../lib/types";
import { shellStyles, statusChipStyle } from "../lib/ui";

const SERVICE_STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  disabled: "#64748b",
  error: "#ef4444",
  key_needed: "#f59e0b",
};

const EMPTY_SERVICE_FORM = {
  auth_type: "api_key",
  base_url: "",
  credential: "",
  description: "",
  display_name: "",
  service_name: "",
  status: "key_needed",
};

export function SettingsControlPage() {
  const [services, setServices] = useState<ServiceEntryRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [scheduleInputs, setScheduleInputs] = useState<Record<string, string>>({});
  const [serviceForm, setServiceForm] = useState(EMPTY_SERVICE_FORM);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [savingService, setSavingService] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedService = useMemo(
    () => services.find((service) => service.id === selectedServiceId) || null,
    [selectedServiceId, services]
  );

  async function loadSettings() {
    const [servicesData, schedulesData] = await Promise.all([
      api.getServices(),
      api.getSchedules(),
    ]);

    setServices(servicesData || []);
    setSchedules(schedulesData || []);
    setScheduleInputs(
      Object.fromEntries(
        (schedulesData || []).map((schedule) => [schedule.id, schedule.cron_expr || ""])
      )
    );
  }

  useEffect(() => {
    void loadSettings().catch((nextError) =>
      setError(nextError instanceof Error ? nextError.message : "Failed to load settings.")
    );
  }, []);

  useEffect(() => {
    if (!selectedService) {
      return;
    }

    setServiceForm({
      auth_type: selectedService.auth_type || "api_key",
      base_url: selectedService.base_url || "",
      credential: "",
      description: selectedService.description || "",
      display_name: selectedService.display_name || "",
      service_name: selectedService.service_name || "",
      status: selectedService.status || "key_needed",
    });
  }, [selectedServiceId]);

  async function saveService() {
    setSavingService(true);
    setError(null);
    try {
      if (editingServiceId) {
        await api.updateService(editingServiceId, {
          auth_type: serviceForm.auth_type,
          base_url: serviceForm.base_url || null,
          credential: serviceForm.credential || undefined,
          description: serviceForm.description,
          display_name: serviceForm.display_name,
          status: serviceForm.status,
        });
      } else {
        const created = await api.createService({
          auth_type: serviceForm.auth_type,
          base_url: serviceForm.base_url || null,
          credential: serviceForm.credential || undefined,
          description: serviceForm.description,
          display_name: serviceForm.display_name,
          service_name: serviceForm.service_name,
        });
        setSelectedServiceId(created.id);
      }

      setEditingServiceId(null);
      setServiceForm(EMPTY_SERVICE_FORM);
      await loadSettings();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save service.");
    } finally {
      setSavingService(false);
    }
  }

  async function deleteSelectedService() {
    if (!selectedServiceId) {
      return;
    }

    await api.deleteService(selectedServiceId);
    setSelectedServiceId(null);
    setEditingServiceId(null);
    setServiceForm(EMPTY_SERVICE_FORM);
    await loadSettings();
  }

  async function saveKey(serviceId: string) {
    if (!serviceForm.credential.trim()) {
      return;
    }

    await api.saveServiceCredential(serviceId, serviceForm.credential.trim());
    setServiceForm((current) => ({ ...current, credential: "" }));
    await loadSettings();
  }

  async function toggleSchedule(id: string, enabled: boolean) {
    await api.setScheduleEnabled(id, enabled);
    await loadSettings();
  }

  async function saveSchedule(id: string) {
    const cron_expr = (scheduleInputs[id] || "").trim();
    if (!cron_expr) {
      return;
    }

    await api.saveSchedule(id, { cron_expr });
    await loadSettings();
  }

  function startCreateService() {
    setEditingServiceId(null);
    setSelectedServiceId(null);
    setServiceForm(EMPTY_SERVICE_FORM);
  }

  function startEditService(service: ServiceEntryRecord) {
    setEditingServiceId(service.id);
    setSelectedServiceId(service.id);
  }

  return (
    <div>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>Settings</h2>
          <p style={{ ...shellStyles.muted, margin: 0 }}>
            Service registry CRUD plus schedule management.
          </p>
        </div>
        <button onClick={startCreateService} style={shellStyles.button} type="button">
          Add Service
        </button>
      </div>

      {error && <div style={{ color: "#fca5a5", marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(320px, 0.9fr) minmax(0, 1.1fr)" }}>
        <div style={shellStyles.card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Service Connections</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {services.map((service) => (
              <button
                key={service.id}
                onClick={() => setSelectedServiceId(service.id)}
                style={{
                  background: selectedServiceId === service.id ? "#162032" : "transparent",
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
                  <div style={{ color: "#f8fafc", fontWeight: 600 }}>{service.display_name}</div>
                  <span
                    style={statusChipStyle(
                      SERVICE_STATUS_COLORS[service.status] || "#64748b"
                    )}
                  >
                    {service.status}
                  </span>
                </div>
                <div style={shellStyles.muted}>{service.service_name}</div>
                <div style={{ ...shellStyles.muted, marginTop: 4 }}>
                  {service.base_url || "No base URL"} • last verified {formatDateTime(service.last_verified)}
                </div>
              </button>
            ))}
            {services.length === 0 && <div style={shellStyles.muted}>No services registered.</div>}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={shellStyles.card}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                {editingServiceId ? "Edit Service" : "Service Form"}
              </h3>
              {selectedService && !editingServiceId && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => startEditService(selectedService)}
                    style={{ ...shellStyles.button, ...shellStyles.buttonSecondary }}
                    type="button"
                  >
                    Edit Selected
                  </button>
                  <button
                    onClick={() => void deleteSelectedService()}
                    style={{ ...shellStyles.button, ...shellStyles.buttonDanger }}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <label style={shellStyles.label}>Service Name</label>
                  <input
                    disabled={Boolean(editingServiceId)}
                    onChange={(event) =>
                      setServiceForm((current) => ({
                        ...current,
                        service_name: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, opacity: editingServiceId ? 0.7 : 1, width: "100%" }}
                    value={serviceForm.service_name}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Display Name</label>
                  <input
                    onChange={(event) =>
                      setServiceForm((current) => ({
                        ...current,
                        display_name: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={serviceForm.display_name}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "180px 1fr 160px" }}>
                <div>
                  <label style={shellStyles.label}>Auth Type</label>
                  <select
                    onChange={(event) =>
                      setServiceForm((current) => ({
                        ...current,
                        auth_type: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={serviceForm.auth_type}
                  >
                    <option value="api_key">api_key</option>
                    <option value="bearer">bearer</option>
                    <option value="none">none</option>
                  </select>
                </div>
                <div>
                  <label style={shellStyles.label}>Base URL</label>
                  <input
                    onChange={(event) =>
                      setServiceForm((current) => ({
                        ...current,
                        base_url: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={serviceForm.base_url}
                  />
                </div>
                <div>
                  <label style={shellStyles.label}>Status</label>
                  <select
                    onChange={(event) =>
                      setServiceForm((current) => ({
                        ...current,
                        status: event.target.value,
                      }))
                    }
                    style={{ ...shellStyles.input, width: "100%" }}
                    value={serviceForm.status}
                  >
                    <option value="key_needed">key_needed</option>
                    <option value="active">active</option>
                    <option value="error">error</option>
                    <option value="disabled">disabled</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={shellStyles.label}>Description</label>
                <textarea
                  onChange={(event) =>
                    setServiceForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  style={{ ...shellStyles.textarea, width: "100%" }}
                  value={serviceForm.description}
                />
              </div>
              <div>
                <label style={shellStyles.label}>
                  {editingServiceId ? "Rotate Credential" : "Credential"}
                </label>
                <input
                  onChange={(event) =>
                    setServiceForm((current) => ({
                      ...current,
                      credential: event.target.value,
                    }))
                  }
                  placeholder={editingServiceId ? "Paste new credential" : "Paste credential"}
                  style={{ ...shellStyles.input, width: "100%" }}
                  type="password"
                  value={serviceForm.credential}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={savingService}
                  onClick={() => void saveService()}
                  style={{ ...shellStyles.button, opacity: savingService ? 0.7 : 1 }}
                  type="button"
                >
                  {savingService ? "Saving..." : editingServiceId ? "Save Service" : "Create Service"}
                </button>
                {selectedService && !editingServiceId && (
                  <button
                    onClick={() => void saveKey(selectedService.id)}
                    style={{ ...shellStyles.button, ...shellStyles.buttonGhost }}
                    type="button"
                  >
                    Update Key
                  </button>
                )}
              </div>
              {selectedService?.error_message && (
                <div style={{ color: "#fca5a5" }}>{selectedService.error_message}</div>
              )}
            </div>
          </div>

          <div style={shellStyles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Schedules</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  style={{
                    border: "1px solid #253247",
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                      <div style={{ color: "#f8fafc", fontWeight: 600 }}>{schedule.name}</div>
                      <div style={shellStyles.muted}>{schedule.assigned_role}</div>
                    </div>
                    <button
                      onClick={() => void toggleSchedule(schedule.id, !schedule.enabled)}
                      style={{
                        ...shellStyles.button,
                        ...(schedule.enabled ? shellStyles.buttonSecondary : shellStyles.buttonGhost),
                      }}
                      type="button"
                    >
                      {schedule.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto" }}>
                    <input
                      onChange={(event) =>
                        setScheduleInputs((current) => ({
                          ...current,
                          [schedule.id]: event.target.value,
                        }))
                      }
                      style={{ ...shellStyles.input, width: "100%" }}
                      value={scheduleInputs[schedule.id] || ""}
                    />
                    <button
                      onClick={() => void saveSchedule(schedule.id)}
                      style={shellStyles.button}
                      type="button"
                    >
                      Save
                    </button>
                  </div>
                  <div style={{ ...shellStyles.muted, marginTop: 8 }}>
                    Last run {formatDateTime(schedule.last_run_at)} • next run{" "}
                    {formatDateTime(schedule.next_run_at)}
                  </div>
                </div>
              ))}
              {schedules.length === 0 && <div style={shellStyles.muted}>No schedules configured.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

