export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: { body?: unknown; method?: string } = {}
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

export const api = {
  approveApproval: (approvalId: string) =>
    apiPost<void>(`/approvals/${approvalId}/decision`, {
      decision: "approved",
    }),
  expireMemory: (memoryId: string) => apiPost<void>(`/memories/${memoryId}/expire`),
  getAgents: (): Promise<any[]> => apiGet<any[]>("/agents"),
  getApprovals: (): Promise<any[]> => apiGet<any[]>("/approvals"),
  getEvents: (): Promise<any[]> => apiGet<any[]>("/events"),
  getMemories: (query = "") =>
    apiGet<any[]>(
      `/memories${query ? `?q=${encodeURIComponent(query)}` : ""}`
    ),
  getMessages: (): Promise<any[]> =>
    apiGet<any[]>("/messages?channel=admin_chat&limit=100"),
  getRoles: (): Promise<any[]> => apiGet<any[]>("/roles"),
  getRuntimeProvider: (): Promise<any> => apiGet<any>("/runtime/provider"),
  getOpenAiDeviceAuth: (): Promise<any> =>
    apiGet<any>("/runtime/provider/openai/device-auth"),
  getSchedules: (): Promise<any[]> => apiGet<any[]>("/schedules"),
  getServices: (): Promise<any[]> => apiGet<any[]>("/services"),
  getSession: (): Promise<any> => apiGet<any>("/auth/session"),
  getTasks: (): Promise<any[]> => apiGet<any[]>("/tasks"),
  login: (user: string, pass: string): Promise<any> =>
    apiPost<any>("/auth/login", { pass, user }),
  logout: () => apiPost<void>("/auth/logout"),
  rejectApproval: (approvalId: string) =>
    apiPost<void>(`/approvals/${approvalId}/decision`, {
      decision: "rejected",
    }),
  retryTask: (taskId: string) => apiPost<void>(`/tasks/${taskId}/retry`),
  startOpenAiDeviceAuth: (): Promise<any> =>
    apiPost<any>("/runtime/provider/openai/device-auth/start"),
  cancelOpenAiDeviceAuth: (): Promise<any> =>
    apiPost<any>("/runtime/provider/openai/device-auth/cancel"),
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
  saveServiceCredential: (serviceId: string, credential: string) =>
    apiPost<void>(`/services/${serviceId}/credential`, { credential }),
  saveSchedule: (scheduleId: string, payload: { cron_expr?: string; enabled?: boolean }) =>
    apiPost<void>(`/schedules/${scheduleId}`, payload),
  sendMessage: (content: string) =>
    apiPost("/messages", {
      channel: "admin_chat",
      content,
      direction: "inbound",
      sender: "operator",
    }),
  setScheduleEnabled: (scheduleId: string, enabled: boolean) =>
    apiPost<void>(`/schedules/${scheduleId}/toggle`, { enabled }),
};
