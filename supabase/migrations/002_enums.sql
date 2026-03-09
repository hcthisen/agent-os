-- Task states (strict state machine)
CREATE TYPE task_state AS ENUM (
  'backlog',
  'ready',
  'claimed',
  'running',
  'blocked_on_human',
  'blocked_on_agent',
  'in_review',
  'completed',
  'failed',
  'dead_letter'
);

-- Task priority
CREATE TYPE task_priority AS ENUM (
  'critical',
  'high',
  'normal',
  'low'
);

-- Scope types for memory, events, etc.
CREATE TYPE scope_type AS ENUM (
  'task',
  'project',
  'customer',
  'role',
  'department',
  'company'
);

-- Event severity levels
CREATE TYPE event_severity AS ENUM (
  'info',
  'warning',
  'error',
  'critical'
);

-- Memory layers
CREATE TYPE memory_layer AS ENUM (
  'episodic',
  'semantic',
  'procedural'
);

-- Approval status
CREATE TYPE approval_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'expired'
);

-- Agent status
CREATE TYPE agent_status AS ENUM (
  'active',
  'paused',
  'disabled'
);

-- Service registry status
CREATE TYPE service_status AS ENUM (
  'active',
  'key_needed',
  'error',
  'disabled'
);
