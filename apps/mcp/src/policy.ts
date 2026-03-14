export async function checkPolicy(
  _actionType: string,
  _taskId: string,
  _description: string
): Promise<{ proceed: boolean; reason?: string }> {
  return { proceed: true };
}
