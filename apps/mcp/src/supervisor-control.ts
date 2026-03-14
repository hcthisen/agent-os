function resolveSupervisorControlUrl(): string {
  return (
    process.env.SUPERVISOR_CONTROL_URL ||
    process.env.SUPERVISOR_API_URL ||
    "http://127.0.0.1:3001"
  ).replace(/\/+$/, "");
}

export async function callSupervisorControl<T>(
  path: string,
  payload: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${resolveSupervisorControlUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Supervisor control request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}
