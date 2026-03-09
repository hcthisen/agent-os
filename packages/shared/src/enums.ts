export const TaskState = {
  BACKLOG: "backlog",
  READY: "ready",
  CLAIMED: "claimed",
  RUNNING: "running",
  BLOCKED_ON_HUMAN: "blocked_on_human",
  BLOCKED_ON_AGENT: "blocked_on_agent",
  IN_REVIEW: "in_review",
  COMPLETED: "completed",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
} as const;
export type TaskState = (typeof TaskState)[keyof typeof TaskState];

export const TaskPriority = {
  CRITICAL: "critical",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const ScopeType = {
  TASK: "task",
  PROJECT: "project",
  CUSTOMER: "customer",
  ROLE: "role",
  DEPARTMENT: "department",
  COMPANY: "company",
} as const;
export type ScopeType = (typeof ScopeType)[keyof typeof ScopeType];

export const EventSeverity = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
  CRITICAL: "critical",
} as const;
export type EventSeverity = (typeof EventSeverity)[keyof typeof EventSeverity];

export const MemoryLayer = {
  EPISODIC: "episodic",
  SEMANTIC: "semantic",
  PROCEDURAL: "procedural",
} as const;
export type MemoryLayer = (typeof MemoryLayer)[keyof typeof MemoryLayer];

export const ApprovalStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
} as const;
export type ApprovalStatus =
  (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const AgentStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
  DISABLED: "disabled",
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const ServiceStatus = {
  ACTIVE: "active",
  KEY_NEEDED: "key_needed",
  ERROR: "error",
  DISABLED: "disabled",
} as const;
export type ServiceStatus =
  (typeof ServiceStatus)[keyof typeof ServiceStatus];

export const ClaudeModel = {
  OPUS: "opus",
  SONNET: "sonnet",
  HAIKU: "haiku",
} as const;
export type ClaudeModel = (typeof ClaudeModel)[keyof typeof ClaudeModel];

export const ClaudeEffort = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;
export type ClaudeEffort = (typeof ClaudeEffort)[keyof typeof ClaudeEffort];

export const TaskRunStatus = {
  STARTED: "started",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMEOUT: "timeout",
} as const;
export type TaskRunStatus =
  (typeof TaskRunStatus)[keyof typeof TaskRunStatus];
