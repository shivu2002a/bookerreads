"use client";

/**
 * IndexedDB outbox for handoff and return confirmations (Requirements 6.7, 14.5).
 *
 * When a confirmation fails for network reasons (or the device is offline), the
 * intent is stored here and the UI shows it as confirmed with a "will sync"
 * badge. Replay happens on the `online` event and on app start. Server actions
 * are idempotent for repeats: a replay after the original did land returns
 * `already_confirmed`, which we treat as success.
 */

export type OutboxItem = {
  id: string;
  loanId: string;
  action:
    | "confirm_handoff_photo"
    | "confirm_handoff_code"
    | "confirm_return_photo"
    | "confirm_return_code";
  args: { photoPath?: string; code?: string; condition?: "like_new" | "good" | "worn" };
  createdAt: number;
  attempts: number;
};

const DB_NAME = "bookerreads";
const STORE = "outbox";
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export const outbox = {
  supported: () => typeof indexedDB !== "undefined",

  async add(item: Omit<OutboxItem, "id" | "createdAt" | "attempts">): Promise<OutboxItem> {
    const full: OutboxItem = {
      ...item,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      attempts: 0,
    };
    await tx("readwrite", (s) => s.put(full));
    notify();
    return full;
  },

  async list(): Promise<OutboxItem[]> {
    const items = await tx<OutboxItem[]>("readonly", (s) => s.getAll());
    return items.sort((a, b) => a.createdAt - b.createdAt);
  },

  async remove(id: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(id));
    notify();
  },

  async bump(item: OutboxItem): Promise<void> {
    await tx("readwrite", (s) => s.put({ ...item, attempts: item.attempts + 1 }));
  },

  async pendingFor(loanId: string): Promise<OutboxItem[]> {
    return (await this.list()).filter((i) => i.loanId === loanId);
  },
};

// ---------------------------------------------------------------------------
// change notifications for React
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True for fetch/network failures, false for server-side refusals. */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("load failed") ||
    msg.includes("fetch failed")
  );
}
