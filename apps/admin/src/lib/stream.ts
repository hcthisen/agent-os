import type { AdminStreamSnapshot } from "./types";

type SnapshotListener = (snapshot: AdminStreamSnapshot) => void;

const listeners = new Set<SnapshotListener>();
let latestSnapshot: AdminStreamSnapshot | null = null;
let stream: EventSource | null = null;

function notify(snapshot: AdminStreamSnapshot) {
  latestSnapshot = snapshot;
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function ensureStream() {
  if (stream || typeof window === "undefined") {
    return;
  }

  stream = new EventSource("/api/stream", { withCredentials: true });
  stream.addEventListener("snapshot", (event) => {
    try {
      notify(JSON.parse(event.data) as AdminStreamSnapshot);
    } catch (error) {
      console.error("Failed to parse admin stream snapshot:", error);
    }
  });
  stream.onerror = () => {
    if (stream?.readyState === EventSource.CLOSED) {
      stream.close();
      stream = null;
    }
  };
}

function maybeCloseStream() {
  if (listeners.size > 0 || !stream) {
    return;
  }

  stream.close();
  stream = null;
  latestSnapshot = null;
}

export function subscribeAdminStream(listener: SnapshotListener): () => void {
  listeners.add(listener);
  ensureStream();

  if (latestSnapshot) {
    listener(latestSnapshot);
  }

  return () => {
    listeners.delete(listener);
    maybeCloseStream();
  };
}
