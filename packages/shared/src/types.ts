import type {
  TaskState,
  TaskPriority,
  ScopeType,
  EventSeverity,
  MemoryLayer,
  AgentStatus,
  ServiceStatus,
  ClaudeModel,
  ClaudeEffort,
  TaskRunStatus,
} from "./enums.js";

export interface Role {
  id: string;
  display_name: string;
  description: string;
  policy_doc: string;
  usage_summary: string;
  handoff_when: string;
  model: ClaudeModel;
  effort: ClaudeEffort;
  max_concurrent_tasks: number;
  is_system_role: boolean;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  role_id: string;
  status: AgentStatus;
  config: Record<string, unknown>;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoleDirectoryEntry {
  id: string;
  display_name: string;
  description: string;
  usage_summary: string;
  handoff_when: string;
  is_system_role: boolean;
  active_agent_count: number;
}

export interface Project {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  repo_url: string | null;
  metadata: Record<string, unknown>;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  customer_id: string | null;
  department_id: string | null;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  state: TaskState;
  priority: TaskPriority;
  assigned_role: string;
  claimed_by: string | null;
  claimed_at: string | null;
  attempt_count: number;
  max_attempts: number;
  blocked_reason: string | null;
  depends_on: string[];
  is_system_modification: boolean;
  last_handoff_note: string | null;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  last_activity_at?: string | null;
  last_activity_summary?: string | null;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  task_id: string;
  agent_id: string;
  trace_id: string;
  status: TaskRunStatus;
  context_pack: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  handoff_note: string | null;
  model_used: string;
  effort_used: string;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

export interface Event {
  id: string;
  trace_id: string | null;
  agent_id: string;
  event_type: string;
  severity: EventSeverity;
  scope_type: ScopeType;
  scope_id: string;
  summary: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface Memory {
  id: string;
  layer: MemoryLayer;
  scope_type: ScopeType;
  scope_id: string;
  subject: string;
  content: string;
  tags: string[];
  source_event_id: string | null;
  source_agent_id: string | null;
  confidence: number;
  superseded_by: string | null;
  last_verified_at: string;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemoryChunk {
  id: string;
  source_type: string;
  source_id: string;
  scope_type: ScopeType;
  scope_id: string;
  content: string;
  embedding: number[] | null;
  created_at: string;
}

export interface Artifact {
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
}

export interface TaskRequirement {
  id: string;
  task_id: string;
  requirement_type: string;
  target: string;
  expected: Record<string, unknown>;
  status: string;
  required_for_completion: boolean;
  last_result: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Handoff {
  id: string;
  task_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  to_role_id: string | null;
  summary: string;
  changes_made: unknown[];
  blockers: unknown[];
  next_steps: unknown[];
  context_snapshot: Record<string, unknown>;
  created_at: string;
}

export interface Schedule {
  id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  assigned_role: string;
  task_template: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface ServiceRegistryEntry {
  id: string;
  service_name: string;
  display_name: string;
  description: string;
  base_url: string | null;
  auth_type: string;
  credential: string | null;
  status: ServiceStatus;
  last_verified: string | null;
  error_message: string | null;
  registered_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillStep {
  order: number;
  instruction: string;
  tool_hint: string | null;
  required: boolean;
}

export interface Skill {
  id: string;
  name: string;
  display_name: string;
  description: string;
  trigger_when: string;
  steps: SkillStep[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  required_services: string[];
  scope_type: ScopeType;
  scope_id: string;
  tags: string[];
  version: number;
  last_used_at: string | null;
  use_count: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  channel: string;
  direction: string;
  sender: string;
  content: string;
  metadata: Record<string, unknown>;
  task_id: string | null;
  processed: boolean;
  created_at: string;
}

export interface ContextPack {
  task: Task;
  project: Project | null;
  role: Role;
  role_policy: string;
  agent_identity: Agent | null;
  available_roles: RoleDirectoryEntry[];
  model: ClaudeModel;
  effort: ClaudeEffort;
  last_handoff: Handoff | null;
  recent_events: Event[];
  related_memories: Memory[];
  relevant_skills?: Skill[];
  related_artifacts: Artifact[];
  dependency_tasks: Task[];
  child_tasks: Task[];
  task_requirements: TaskRequirement[];
}
