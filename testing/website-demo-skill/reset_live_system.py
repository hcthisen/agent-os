from __future__ import annotations

import sys
from pathlib import Path

import paramiko


ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = ROOT / ".env"
BOOTSTRAP_SKILLS_SQL_PATH = (
    ROOT / "supabase" / "migrations" / "042_refine_shared_skill_catalog.sql"
)
REMOTE_APP_DIR = "/opt/agent-os"
REMOTE_WORKSPACES_DIR = "/var/lib/docker/volumes/agent-os_workspaces/_data"
PRESERVED_SERVICE_NAMES = ["openai"]
PRESERVED_SKILL_SUBJECTS = [
    "skill:agent-browser",
    "skill:agent-browser-ui-verification",
    "skill:live-vps-validation",
    "skill:shared-skill-authoring",
]
RESET_TABLES = [
    "artifacts",
    "events",
    "handoffs",
    "messages",
    "projects",
    "schedules",
    "skill_drafts",
    "task_requirements",
    "task_runs",
    "tasks",
]


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def run_remote(client: paramiko.SSHClient, command: str) -> str:
    stdin, stdout, stderr = client.exec_command(command)
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if exit_code != 0:
        raise RuntimeError(f"Remote command failed ({exit_code}):\n{command}\n\n{out}{err}")
    return out


def main() -> int:
    env = parse_env(ENV_PATH)
    host = env.get("VPS_IP")
    username = env.get("VPS_USER", "root")
    password = env.get("VPS_PASSWD") or env.get("VPS_SSH_PASSWD")

    if not host or not password:
        print("Missing VPS_IP or both VPS_PASSWD and VPS_SSH_PASSWD in .env", file=sys.stderr)
        return 1

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, username=username, password=password, timeout=20)

    try:
        print(f"Connected to {username}@{host}")
        run_remote(
            client,
            f"""
set -euo pipefail
cd {REMOTE_APP_DIR}
docker compose stop supervisor admin >/dev/null
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d agent_os <<'SQL'
DO $$
DECLARE
  existing_tables text;
  preserved_memory_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO preserved_memory_ids
  FROM memories
  WHERE layer = 'procedural'
    AND scope_type = 'company'
    AND scope_id = 'system'
    AND is_active = true
    AND tags @> ARRAY['skill']::text[]
    AND subject = ANY (ARRAY[{", ".join("'" + name + "'" for name in PRESERVED_SKILL_SUBJECTS)}]);

  SELECT string_agg(format('%I', table_name), ', ' ORDER BY table_name)
  INTO existing_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = ANY (ARRAY[{", ".join("'" + name + "'" for name in RESET_TABLES)}]);

  IF existing_tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || existing_tables || ' RESTART IDENTITY CASCADE';
  END IF;

  DELETE FROM memory_chunks
  WHERE source_type = 'memory'
    AND source_id <> ALL (preserved_memory_ids);

  DELETE FROM memories
  WHERE id <> ALL (preserved_memory_ids);
END $$;
DELETE FROM service_registry
WHERE service_name <> ALL (ARRAY[{", ".join("'" + name + "'" for name in PRESERVED_SERVICE_NAMES)}]);
SQL
rm -rf {REMOTE_WORKSPACES_DIR}/*
docker compose up -d admin supervisor >/dev/null
"""
        )
        bootstrap_sql = BOOTSTRAP_SKILLS_SQL_PATH.read_text(encoding="utf-8")
        stdin, stdout, stderr = client.exec_command(
            f"cd {REMOTE_APP_DIR} && docker compose exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d agent_os"
        )
        stdin.write(bootstrap_sql)
        stdin.channel.shutdown_write()
        exit_code = stdout.channel.recv_exit_status()
        if exit_code != 0:
            out = stdout.read().decode("utf-8", errors="replace")
            err = stderr.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Failed to reseed bootstrap skills ({exit_code}):\n{out}{err}"
            )

        counts = run_remote(
            client,
            f"""
set -euo pipefail
cd {REMOTE_APP_DIR}
docker compose exec -T db psql -At -F $'\\t' -U supabase_admin -d agent_os <<'SQL'
SELECT 'messages', COUNT(*) FROM messages
UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
UNION ALL SELECT 'handoffs', COUNT(*) FROM handoffs
UNION ALL SELECT 'artifacts', COUNT(*) FROM artifacts
UNION ALL SELECT 'events', COUNT(*) FROM events
UNION ALL SELECT 'task_requirements', COUNT(*) FROM task_requirements
UNION ALL SELECT 'task_runs', COUNT(*) FROM task_runs
UNION ALL SELECT 'projects', COUNT(*) FROM projects
UNION ALL SELECT 'memories', COUNT(*) FROM memories
UNION ALL SELECT 'memory_chunks', COUNT(*) FROM memory_chunks
UNION ALL SELECT 'schedules', COUNT(*) FROM schedules
UNION ALL SELECT 'service_registry_preserved', COUNT(*) FROM service_registry;
SQL
docker compose ps --status running
"""
        )
        print(counts.strip())
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
