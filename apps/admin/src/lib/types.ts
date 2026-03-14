export interface MessageRecord {
  id: string;
  channel: string;
  direction: string;
  sender: string;
  content: string;
  created_at: string;
  task_id: string | null;
  metadata: Record<string, unknown>;
}

export interface RoleRecord {
  id: string;
  display_name: string;
  description: string;
  policy_doc: string;
  usage_summary: string;
  handoff_when: string;
  model: string;
  effort: string;
  max_concurrent_tasks: number;
  is_system_role: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  role_id: string;
  status: string;
  config: Record<string, unknown>;
  last_seen_at: string | null;
  role_profile?: RoleRecord | null;
  created_at?: string;
  updated_at?: string;
}

export interface TaskRunRecord {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name?: string | null;
  trace_id: string;
  status: string;
  context_pack: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  handoff_note: string | null;
  model_used: string;
  effort_used: string;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  duration_ms?: number | null;
  task_title?: string | null;
}

export interface EventRecord {
  id: string;
  trace_id: string | null;
  agent_id: string | null;
  event_type: string;
  severity: string;
  scope_type: string;
  scope_id: string;
  summary: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface ProviderUsageSummaryRecord {
  estimated_cost_usd: number | null;
  event_count: number;
  total_tokens: number;
  providers: Array<{
    estimated_cost_usd: number | null;
    event_count: number;
    provider: string;
    total_tokens: number;
  }>;
}

export interface TaskRecord {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  customer_id?: string | null;
  department_id?: string | null;
  simulation_only?: boolean;
  depends_on?: string[] | null;
  title: string;
  objective?: string;
  acceptance_criteria?: string[];
  state: string;
  priority: string;
  assigned_role: string;
  claimed_by: string | null;
  attempt_count: number;
  blocked_reason: string | null;
  last_handoff_note: string | null;
  last_activity_at?: string | null;
  last_activity_summary?: string | null;
  created_at: string;
  updated_at: string;
  due_at?: string | null;
  project?: ProjectRecord | null;
}

export interface ArtifactRecord {
  id: string;
  project_id: string | null;
  task_id: string | null;
  artifact_type: string;
  name: string;
  storage_path: string | null;
  external_url: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  task_title?: string | null;
  project_name?: string | null;
}

export interface TaskDetailRecord {
  task: TaskRecord;
  project: ProjectRecord | null;
  parent_task: TaskRecord | null;
  child_tasks: TaskRecord[];
  task_runs: TaskRunRecord[];
  related_events: EventRecord[];
  related_memories: MemoryRecord[];
  artifacts: ArtifactRecord[];
}

export interface MemoryRecord {
  id: string;
  layer: string;
  scope_type: string;
  scope_id: string;
  subject: string;
  content: string;
  tags: string[];
  source_event_id: string | null;
  source_agent_id: string | null;
  confidence: number;
  superseded_by: string | null;
  last_verified_at?: string | null;
  expires_at?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at?: string;
}

export interface ServiceEntryRecord {
  id: string;
  service_name: string;
  display_name: string;
  description: string;
  base_url: string | null;
  auth_type: string;
  status: string;
  error_message: string | null;
  last_verified: string | null;
  updated_at?: string;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  cron_expr: string;
  assigned_role: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  task_template?: Record<string, unknown>;
  created_at?: string;
}

export interface ProjectRecord {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  repo_url: string | null;
  metadata?: Record<string, unknown>;
  archived?: boolean;
  created_at: string;
  updated_at?: string;
  task_count?: number;
  active_task_count?: number;
  artifact_count?: number;
}

export interface SkillStepRecord {
  order: number;
  instruction: string;
  tool_hint: string | null;
  required: boolean;
}

export interface SkillRecord {
  id: string;
  name: string;
  display_name: string;
  description: string;
  trigger_when: string;
  steps: SkillStepRecord[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  required_services: string[];
  scope_type: string;
  scope_id: string;
  tags: string[];
  version: number;
  use_count: number;
  last_used_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  memory_subject?: string;
  superseded_by?: string | null;
  source_agent_id?: string | null;
}

export interface SkillDetailRecord {
  skill: SkillRecord;
  versions: Array<Pick<SkillRecord, "created_at" | "id" | "is_active" | "updated_at" | "use_count" | "version">>;
}

export interface AgentActivityRecord {
  agent: AgentRecord | null;
  events: EventRecord[];
  task_runs: TaskRunRecord[];
}

export interface UsageWindowSummary {
  run_count: number;
  runs_per_role: Array<{ average_duration_ms: number | null; role_id: string; run_count: number }>;
  model_distribution: Array<{ count: number; model: string }>;
}

export interface UsageSummaryRecord {
  provider_usage: ProviderUsageSummaryRecord;
  task_runs: {
    today: UsageWindowSummary;
    week: UsageWindowSummary;
    month: UsageWindowSummary;
  };
  recent_artifacts: ArtifactRecord[];
  recent_projects: ProjectRecord[];
}

export interface LiveActivityRecord {
  agent_id: string | null;
  agent_name: string | null;
  last_activity_at: string | null;
  last_activity_summary: string | null;
  role_id: string;
  started_at: string | null;
  task_id: string;
  task_state: string;
  task_title: string;
}

export interface AdminStreamSnapshot {
  generated_at: string;
  live_activity: LiveActivityRecord[];
  messages: MessageRecord[];
  tasks: TaskRecord[];
}

export interface SkillDraftStepRecord {
  order: number;
  instruction: string;
  required: boolean;
  tool_hint: string | null;
}

export interface SkillDraftRecord {
  id: string;
  source_message_id: string | null;
  source_content: string;
  name: string;
  display_name: string;
  description: string;
  trigger_when: string;
  steps: SkillDraftStepRecord[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  required_services: string[];
  scope_type: string;
  scope_id: string;
  tags: string[];
  status: string;
  confirmed_skill_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}
