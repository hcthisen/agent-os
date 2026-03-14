import type {
  AgentActivityRecord,
  AgentRecord,
  ArtifactRecord,
  EventRecord,
  MemoryRecord,
  MessageRecord,
  ProjectRecord,
  RoleRecord,
  ScheduleRecord,
  ServiceEntryRecord,
  SkillDraftRecord,
  SkillDetailRecord,
  SkillRecord,
  TaskDetailRecord,
  TaskRecord,
  TaskRunRecord,
  UsageSummaryRecord,
} from "./types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type RequestOptions = {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
};

async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "include",
    headers:
      options.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    method: options.method || "GET",
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;

  if (!response.ok) {
    throw new ApiError(
      payload?.error || `Request failed with status ${response.status}`,
      response.status
    );
  }

  return payload as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { body, method: "POST" });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { body, method: "PATCH" });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

function buildQueryString(
  params: Record<string, boolean | number | string | undefined>
): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export const api = {
  cancelOpenAiDeviceAuth: (): Promise<any> =>
    apiPost<any>("/runtime/provider/openai/device-auth/cancel"),
  createAgent: (
    payload: Partial<AgentRecord> & {
      description: string;
      name: string;
      policy_doc: string;
      display_name?: string;
      effort?: string;
      handoff_when?: string;
      max_concurrent_tasks?: number;
      model?: string;
      role_id?: string;
      usage_summary?: string;
    }
  ) =>
    apiPost<AgentRecord>("/agents", payload),
  createMemory: (
    payload: Pick<
      MemoryRecord,
      "confidence" | "content" | "layer" | "scope_id" | "scope_type" | "subject" | "tags"
    >
  ) => apiPost<MemoryRecord>("/memories", payload),
  bulkImportMemories: (payload: {
    confidence?: number;
    content: string;
    scope_id: string;
    scope_type: string;
    split_mode?: "paragraph" | "sentence";
    subject_prefix?: string;
    tags?: string[];
  }) =>
    apiPost<{ count: number; memories: MemoryRecord[]; split_mode: string }>(
      "/memories/bulk-import",
      payload
    ),
  createProject: (
    payload: Pick<ProjectRecord, "description" | "display_name" | "repo_url" | "slug">
  ) => apiPost<ProjectRecord>("/projects", payload),
  createRole: (
    payload: Partial<RoleRecord> & {
      description: string;
      display_name: string;
      id: string;
      policy_doc: string;
    }
  ) => apiPost<RoleRecord>("/roles", payload),
  createService: (
    payload: Pick<
      ServiceEntryRecord,
      "auth_type" | "base_url" | "description" | "display_name" | "service_name"
    > & { credential?: string }
  ) => apiPost<ServiceEntryRecord>("/services", payload),
  createSkill: (
    payload: Partial<SkillRecord> & { description: string; display_name: string; name: string }
  ) => apiPost<SkillRecord>("/skills", payload),
  createTask: (
    payload: Partial<TaskRecord> & {
      assigned_role: string;
      customer_id?: string | null;
      department_id?: string | null;
      objective: string;
      simulation_only?: boolean;
      title: string;
    }
  ) => apiPost<TaskRecord>("/tasks", payload),
  confirmSkillDraft: (draftId: string) =>
    apiPost<{ draft: SkillDraftRecord; skill: SkillRecord }>(
      `/skill-drafts/${draftId}/confirm`
    ),
  deleteService: (serviceId: string) => apiDelete<void>(`/services/${serviceId}`),
  deleteSkill: (skillId: string) => apiDelete<void>(`/skills/${skillId}`),
  expireMemory: (memoryId: string) => apiPost<void>(`/memories/${memoryId}/expire`),
  getAgent: (agentId: string) => apiGet<AgentRecord>(`/agents/${agentId}`),
  getAgentActivity: (agentId: string) =>
    apiGet<AgentActivityRecord>(`/agents/${agentId}/activity`),
  getAgents: (): Promise<AgentRecord[]> => apiGet<AgentRecord[]>("/agents"),
  getArtifact: (artifactId: string) =>
    apiGet<ArtifactRecord>(`/artifacts/${artifactId}`),
  getArtifacts: (options?: {
    artifact_type?: string;
    limit?: number;
    project_id?: string;
    task_id?: string;
  }): Promise<ArtifactRecord[]> =>
    apiGet<ArtifactRecord[]>(
      `/artifacts${buildQueryString({
        artifact_type: options?.artifact_type,
        limit: options?.limit || 50,
        project_id: options?.project_id,
        task_id: options?.task_id,
      })}`
    ),
  getEvents: (options?: {
    agent_id?: string;
    before?: string;
    date_from?: string;
    date_to?: string;
    event_type?: string;
    limit?: number;
    severity?: string;
  }): Promise<EventRecord[]> =>
    apiGet<EventRecord[]>(
      `/events${buildQueryString({
        agent_id: options?.agent_id,
        before: options?.before,
        date_from: options?.date_from,
        date_to: options?.date_to,
        event_type: options?.event_type,
        limit: options?.limit || 50,
        severity: options?.severity,
      })}`
    ),
  getMemoriesPage: (options?: {
    before?: string;
    layer?: string;
    limit?: number;
    mode?: string;
    query?: string;
    scope_id?: string;
    scope_type?: string;
  }): Promise<MemoryRecord[]> =>
    apiGet<MemoryRecord[]>(
      `/memories${buildQueryString({
        before: options?.before,
        layer: options?.layer,
        limit: options?.limit || 50,
        mode: options?.mode,
        q: options?.query,
        scope_id: options?.scope_id,
        scope_type: options?.scope_type,
      })}`
    ),
  getMessages: (options?: { before?: string; limit?: number }): Promise<MessageRecord[]> =>
    apiGet<MessageRecord[]>(
      `/messages${buildQueryString({
        before: options?.before,
        channel: "admin_chat",
        limit: options?.limit || 50,
      })}`
    ),
  getOpenAiDeviceAuth: (): Promise<any> =>
    apiGet<any>("/runtime/provider/openai/device-auth"),
  getProjects: (): Promise<ProjectRecord[]> => apiGet<ProjectRecord[]>("/projects"),
  getRole: (roleId: string) => apiGet<RoleRecord>(`/roles/${roleId}`),
  getRoles: (): Promise<RoleRecord[]> => apiGet<RoleRecord[]>("/roles"),
  getRuntimeProvider: (): Promise<any> => apiGet<any>("/runtime/provider"),
  getSchedules: (): Promise<ScheduleRecord[]> => apiGet<ScheduleRecord[]>("/schedules"),
  getServices: (): Promise<ServiceEntryRecord[]> =>
    apiGet<ServiceEntryRecord[]>("/services"),
  getSession: (): Promise<any> => apiGet<any>("/auth/session"),
  getAgentInstructions: (): Promise<{ content: string; updated_at: string | null }> =>
    apiGet<{ content: string; updated_at: string | null }>("/settings/agent-instructions"),
  getSkill: (skillId: string) => apiGet<SkillDetailRecord>(`/skills/${skillId}`),
  getSkills: (options?: {
    limit?: number;
    q?: string;
    scope_type?: string;
    tags?: string;
  }): Promise<SkillRecord[]> =>
    apiGet<SkillRecord[]>(
      `/skills${buildQueryString({
        limit: options?.limit || 100,
        q: options?.q,
        scope_type: options?.scope_type,
        tags: options?.tags,
      })}`
    ),
  getTaskDetail: (taskId: string) =>
    apiGet<TaskDetailRecord>(`/tasks/${taskId}/full`),
  getTaskRuns: (taskId: string) =>
    apiGet<TaskRunRecord[]>(`/tasks/${taskId}/runs`),
  getTasks: (options?: {
    before?: string;
    limit?: number;
    project_id?: string;
    q?: string;
    state?: string;
  }): Promise<TaskRecord[]> =>
    apiGet<TaskRecord[]>(
      `/tasks${buildQueryString({
        before: options?.before,
        limit: options?.limit || 50,
        project_id: options?.project_id,
        q: options?.q,
        state: options?.state,
      })}`
    ),
  getUsageSummary: (): Promise<UsageSummaryRecord> =>
    apiGet<UsageSummaryRecord>("/usage/summary"),
  login: (user: string, pass: string): Promise<any> =>
    apiPost<any>("/auth/login", { pass, user }),
  logout: () => apiPost<void>("/auth/logout"),
  rejectSkillDraft: (draftId: string) =>
    apiPost<{ draft: SkillDraftRecord }>(`/skill-drafts/${draftId}/reject`),
  retryTask: (taskId: string) => apiPost<void>(`/tasks/${taskId}/retry`),
  saveRuntimeProvider: (
    activeProvider: string,
    anthropicRoleConfig: Record<string, { effort: string; model: string }>,
    openaiModelMap: Record<string, string>,
    openaiRoleConfig: Record<string, { effort: string; model: string }>
  ) =>
    apiPost<any>("/runtime/provider", {
      activeProvider,
      anthropicRoleConfig,
      openaiModelMap,
      openaiRoleConfig,
    }),
  saveSchedule: (scheduleId: string, payload: { cron_expr?: string; enabled?: boolean }) =>
    apiPost<void>(`/schedules/${scheduleId}`, payload),
  saveServiceCredential: (serviceId: string, credential: string) =>
    apiPost<void>(`/services/${serviceId}/credential`, { credential }),
  sendMessage: (content: string) =>
    apiPost<{ messageId: string | null; relayTaskId: string | null }>("/messages", {
      channel: "admin_chat",
      content,
      direction: "inbound",
      sender: "operator",
    }),
  setScheduleEnabled: (scheduleId: string, enabled: boolean) =>
    apiPost<void>(`/schedules/${scheduleId}/toggle`, { enabled }),
  startOpenAiDeviceAuth: (): Promise<any> =>
    apiPost<any>("/runtime/provider/openai/device-auth/start"),
  updateAgentInstructions: (content: string) =>
    apiPatch<{ content: string; updated_at: string | null }>(
      "/settings/agent-instructions",
      { content }
    ),
  updateAgent: (
    agentId: string,
    payload: Partial<AgentRecord> & {
      description?: string;
      display_name?: string;
      effort?: string;
      handoff_when?: string;
      max_concurrent_tasks?: number;
      model?: string;
      policy_doc?: string;
      usage_summary?: string;
    }
  ) =>
    apiPatch<AgentRecord>(`/agents/${agentId}`, payload),
  updateMemory: (
    memoryId: string,
    payload: Partial<Pick<MemoryRecord, "confidence" | "content" | "subject" | "tags">>
  ) => apiPatch<MemoryRecord>(`/memories/${memoryId}`, payload),
  updateProject: (
    projectId: string,
    payload: Partial<Pick<ProjectRecord, "description" | "display_name" | "repo_url" | "slug">>
  ) => apiPatch<ProjectRecord>(`/projects/${projectId}`, payload),
  updateRole: (roleId: string, payload: Partial<RoleRecord>) =>
    apiPatch<RoleRecord>(`/roles/${roleId}`, payload),
  updateService: (
    serviceId: string,
    payload: Partial<ServiceEntryRecord> & { credential?: string }
  ) => apiPatch<ServiceEntryRecord>(`/services/${serviceId}`, payload),
  updateSkill: (skillId: string, payload: Partial<SkillRecord>) =>
    apiPatch<SkillRecord>(`/skills/${skillId}`, payload),
  updateTask: (
    taskId: string,
    payload: Partial<
      Pick<
        TaskRecord,
        | "acceptance_criteria"
        | "assigned_role"
        | "customer_id"
        | "department_id"
        | "due_at"
        | "objective"
        | "priority"
        | "project_id"
        | "simulation_only"
        | "title"
      >
    >
  ) => apiPatch<TaskRecord>(`/tasks/${taskId}`, payload),
};
