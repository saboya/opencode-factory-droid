import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { FactoryActivity, type ActivityEntry, type PayloadStatus } from "./activity-rpc";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
export type ActivityNotice = Pick<ActivityEntry, "kind" | "message"> & { key: string };
type StoredEntry = ActivityEntry & { key: string };
const storageKey = (sessionID: string) => `factory/activity/${sessionID}`;
const payloadKey = (sessionID: string) => `factory/payload/${sessionID}`;

/** Storage and notifications are best effort and cannot fail a model request. */
export async function registerActivity(ctx: Context) {
  let queue: Promise<void> = Promise.resolve();
  const read = async (sessionID: string): Promise<StoredEntry[]> => {
    const value = await ctx.storage.get(storageKey(sessionID));
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is StoredEntry => !!entry && typeof entry === "object" &&
      "sessionID" in entry && entry.sessionID === sessionID && "id" in entry && typeof entry.id === "string" &&
      "message" in entry && typeof entry.message === "string" && "time" in entry && typeof entry.time === "number" &&
      "key" in entry && typeof entry.key === "string") as StoredEntry[];
  };
  const registration = await ctx.rpc.register(FactoryActivity, {
    list: async (input) => {
      const sessionID = (input as { sessionID: string }).sessionID;
      await queue;
      const entries = await read(sessionID);
      const payload = await ctx.storage.get(payloadKey(sessionID));
      return { entries: entries.map(({ key: _key, ...entry }) => entry), ...(payload ? { payload } : {}) };
    },
  });
  return {
    dispose: async () => { await queue; await registration.dispose(); },
    payload: (sessionID: string, status: PayloadStatus): Promise<void> => {
      const operation = queue.then(async () => {
        await ctx.storage.set(payloadKey(sessionID), { ...status });
        await registration.events.emit("updated", { sessionID });
      }).catch(() => {});
      queue = operation;
      return operation;
    },
    record: (sessionID: string, notice: ActivityNotice): Promise<void> => {
      const operation = queue.then(async () => {
        const entries = await read(sessionID);
        if (entries.some((entry) => entry.key === notice.key)) return;
        entries.push({ ...notice, sessionID, id: randomUUID(), time: Date.now() });
        // Bounded history per session; no prompts, paths, images or credentials.
        await ctx.storage.set(storageKey(sessionID), entries.slice(-200) as unknown as Parameters<typeof ctx.storage.set>[1]);
        await registration.events.emit("updated", { sessionID });
      }).catch(() => {});
      queue = operation;
      return operation;
    },
  };
}
