import { getDb } from "./db.js";

export interface DependencyAwareTask {
  depends_on?: string[] | null;
  id: string;
  last_handoff_note?: string | null;
  state: string;
  title: string;
}

export interface DependencyTaskState {
  id: string;
  state: string;
  title: string;
}

export async function loadDependencyTaskStateMap(
  tasks: Array<{ depends_on?: string[] | null }>
): Promise<Map<string, DependencyTaskState>> {
  const dependencyIds = [...new Set(tasks.flatMap((task) => task.depends_on || []))];
  const stateMap = new Map<string, DependencyTaskState>();

  if (!dependencyIds.length) {
    return stateMap;
  }

  const db = getDb();
  const { data, error } = await db
    .from("tasks")
    .select("id,state,title")
    .in("id", dependencyIds)
    .returns<DependencyTaskState[]>();

  if (error) {
    throw new Error(`Failed to load dependency task states: ${error.message}`);
  }

  for (const row of data || []) {
    stateMap.set(row.id, row);
  }

  return stateMap;
}

export function getUnsatisfiedDependencies(
  task: DependencyAwareTask,
  dependencyStateMap: Map<string, DependencyTaskState>
): DependencyTaskState[] {
  return (task.depends_on || [])
    .map(
      (taskId) =>
        dependencyStateMap.get(taskId) || {
          id: taskId,
          state: "missing",
          title: "Missing dependency task",
        }
    )
    .filter((dependency) => dependency.state !== "completed");
}

export function isTaskLaunchable(
  task: DependencyAwareTask,
  dependencyStateMap: Map<string, DependencyTaskState>
): boolean {
  return getUnsatisfiedDependencies(task, dependencyStateMap).length === 0;
}

export function buildDependencyWaitNote(
  task: DependencyAwareTask,
  dependencyStateMap: Map<string, DependencyTaskState>
): string | null {
  const waitingOn = getUnsatisfiedDependencies(task, dependencyStateMap);
  if (!waitingOn.length) {
    return null;
  }

  const summaries = waitingOn
    .slice(0, 3)
    .map((dependency) => `${dependency.title} (${dependency.id.slice(0, 8)}) [${dependency.state}]`);
  const suffix =
    waitingOn.length > summaries.length
      ? ` and ${waitingOn.length - summaries.length} more`
      : "";

  return `Waiting for dependency task(s) to complete before launch: ${summaries.join(", ")}${suffix}.`;
}
