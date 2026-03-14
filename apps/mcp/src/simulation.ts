import { getCurrentTaskContext } from "./scope.js";

export async function assertTaskMutationAllowed(action: string): Promise<void> {
  const task = await getCurrentTaskContext();
  if (!task?.simulation_only) {
    return;
  }

  throw new Error(
    `${action} is disabled for simulation-only tasks. Report the intended action in the task handoff instead.`
  );
}
