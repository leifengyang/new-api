// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import type { StorageAdapter, StorageCollection } from "@infinite-canvas/shared/storage";
import type { CanvasDocument } from "@infinite-canvas/shared/canvas/schema/canvas";
import { assertArchiveInstall } from "@infinite-canvas/shared/work-archive";
import { assetLibraryEditsSchema, assetLibraryKey, applyAssetEdits } from "@infinite-canvas/shared/sync-records";
import { canCompareChatSync, chatSyncRecordSchema, ordinaryChatWrite, sameChatSyncRecord, serializeCanvasDocument, storedChatSyncRecord, StorageError, type ChatSyncRecord } from "@infinite-canvas/shared/storage-data";
import type { CanvasBridge, CanvasStorageResponse } from "./bridge";

const binaryCollections = new Set(["images", "previews", "media"]);
const scriptKey = "infinite-canvas:call_scripts";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function canvasStorageError(response: CanvasStorageResponse): StorageError {
  const error = new StorageError("STORAGE_UNAVAILABLE");
  if (response.status < 400 || response.body.byteLength > 64 * 1024 ||
    response.contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") return error;
  try {
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    if (payload && typeof payload === "object" && !Array.isArray(payload) &&
      "success" in payload && payload.success === false &&
      "code" in payload && typeof payload.code === "string" && /^CANVAS_[A-Z][A-Z0-9_]{0,95}$/.test(payload.code) &&
      "message" in payload && typeof payload.message === "string" && payload.message.trim().length > 0 && payload.message.length <= 1024) {
      // The authenticated host already translates these stable server error codes.
      error.message = payload.message;
    }
  } catch {
    // Proxy HTML, binary data, and malformed JSON must never become a displayed diagnostic.
  }
  return error;
}

/** A collection retains its own write order; a read observes accepted writes from this tab. */
class CanvasCollection implements StorageCollection {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private bridge: CanvasBridge, private name: string) {}

  private path(key?: string) {
    return `/api/canvas/storage/${this.name}${key === undefined ? "" : `/${encodeURIComponent(key)}`}`;
  }

  async keys(): Promise<string[]> {
    await this.pending;
    const response = await this.bridge.storage({ path: this.path(), method: "GET" });
    if (response.status !== 200) throw canvasStorageError(response);
    const payload = JSON.parse(decoder.decode(response.body));
    if (payload?.success !== true || !Array.isArray(payload.data?.keys) || payload.data.keys.some((key: unknown) => typeof key !== "string")) {
      throw new StorageError("STORAGE_INVALID");
    }
    return payload.data.keys;
  }

  async getItem<T>(key: string): Promise<T | null> {
    if (this.name === "state" && key === scriptKey) return null;
    await this.pending;
    const response = await this.bridge.storage({ path: this.path(key), method: "GET" });
    if (response.status === 404) return null;
    if (response.status !== 200) throw canvasStorageError(response);
    if (binaryCollections.has(this.name)) return new Blob([response.body], { type: response.contentType }) as T;
    return JSON.parse(decoder.decode(response.body)) as T;
  }

  async snapshot(key: string): Promise<{ value: unknown; expectedHash: string }> {
    await this.pending;
    const response = await this.bridge.storage({ path: this.path(key), method: "GET" });
    if (response.status === 404) return { value: null, expectedHash: "absent" };
    if (response.status !== 200) throw canvasStorageError(response);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", response.body));
    const expectedHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    try {
      return { value: JSON.parse(decoder.decode(response.body)), expectedHash };
    } catch {
      throw new StorageError("STORAGE_INVALID");
    }
  }

  compareItem(key: string, value: unknown, expectedHash: string): Promise<boolean> {
    const body = encoder.encode(JSON.stringify(value)).buffer;
    const receipt = this.pending.then(async () => {
      const response = await this.bridge.storage({ path: this.path(key), method: "PUT", body, contentType: "application/json", expectedHash });
      if (response.status === 412) return false;
      if (response.status < 200 || response.status >= 300) throw canvasStorageError(response);
      return true;
    });
    this.pending = receipt.catch(() => undefined);
    return receipt;
  }

  setItem<T>(key: string, value: T): Promise<T> {
    if (this.name === "state" && key === scriptKey) return Promise.reject(new StorageError("STORAGE_INVALID"));
    let snapshot: unknown = value;
    if (this.name === "projects") {
      snapshot = serializeCanvasDocument(value as CanvasDocument);
      const document = snapshot as CanvasDocument;
      if (document.id !== key || document.nodes.some((node) => !["text", "image", "group"].includes(node.type))) {
        return Promise.reject(new StorageError("STORAGE_INVALID"));
      }
    }
    const binary = binaryCollections.has(this.name);
    if (binary && !(snapshot instanceof Blob)) return Promise.reject(new StorageError("STORAGE_INVALID"));
    const bytes = binary ? (snapshot as Blob).arrayBuffer() : Promise.resolve(encoder.encode(JSON.stringify(snapshot)).buffer);
    const contentType = binary ? (snapshot as Blob).type || "application/octet-stream" : "application/json";
    const receipt = this.pending.then(async () => {
      const response = await this.bridge.storage({ path: this.path(key), method: "PUT", body: await bytes, contentType });
      if (response.status < 200 || response.status >= 300) throw canvasStorageError(response);
      return value;
    });
    this.pending = receipt.catch(() => undefined);
    return receipt;
  }

  removeItem(key: string): Promise<void> {
    return this.remove(key);
  }

  clear(): Promise<void> {
    return this.remove();
  }

  private remove(key?: string): Promise<void> {
    const receipt = this.pending.then(async () => {
      const response = await this.bridge.storage({ path: this.path(key), method: "DELETE" });
      if (response.status !== 404 && (response.status < 200 || response.status >= 300)) throw canvasStorageError(response);
    });
    this.pending = receipt.catch(() => undefined);
    return receipt;
  }

  async iterate<T, R>(iterator: (value: T, key: string, index: number) => R): Promise<R | void> {
    let index = 0;
    for (const key of await this.keys()) {
      const value = await this.getItem<T>(key);
      if (value !== null) {
        const result = iterator(value, key, ++index);
        if (result !== undefined) return result;
      }
    }
  }
}

function unsupported(): never { throw new StorageError("STORAGE_INVALID"); }

function readChatRecord(id: string, value: unknown): ChatSyncRecord {
  if (value && typeof value === "object" && "thread" in value && value.thread === null) {
    const parsed = chatSyncRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== id) throw new StorageError("STORAGE_INVALID");
    return parsed.data;
  }
  return storedChatSyncRecord({ key: id, value });
}

const unavailableCollection: StorageCollection = {
  getItem: async () => null,
  iterate: async () => undefined,
  setItem: async () => unsupported(),
  removeItem: async () => unsupported(),
  clear: async () => unsupported(),
};

export function createCanvasStorage(bridge: CanvasBridge): StorageAdapter {
  const state = new CanvasCollection(bridge, "state");
  const projects = new CanvasCollection(bridge, "projects");
  const preferences = new CanvasCollection(bridge, "preferences");
  const images = new CanvasCollection(bridge, "images");
  const rows = new CanvasCollection(bridge, "chats");
  let operations: Promise<unknown> = Promise.resolve();
  // Serialize this editor's mutations; conditional server writes also protect other tabs and devices.
  const ordered = <T>(action: () => Promise<T>): Promise<T> => {
    const receipt = operations.then(action);
    operations = receipt.catch(() => undefined);
    return receipt;
  };
  const chatRecord = async (id: string): Promise<ChatSyncRecord | null> => {
    const value = await rows.getItem<unknown>(id);
    if (value === null) return null;
    return readChatRecord(id, value);
  };
  const writeChat = (id: string, next: ChatSyncRecord | null) => {
    const candidate = structuredClone(next);
    return ordered(async () => {
      if (candidate && (candidate.id !== id || !chatSyncRecordSchema.safeParse(candidate).success)) throw new StorageError("STORAGE_INVALID");
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await rows.snapshot(id);
        const current = snapshot.expectedHash === "absent" ? null : readChatRecord(id, snapshot.value);
        const accepted = ordinaryChatWrite(current, candidate);
        if (!accepted || current && sameChatSyncRecord(current, accepted)) return accepted;
        if (await rows.compareItem(id, accepted.thread ?? accepted, snapshot.expectedHash)) return accepted;
      }
      throw new StorageError("STORAGE_UNAVAILABLE");
    });
  };
  const chats: StorageAdapter["chats"] = {
    async getItem<T>(id: string) { return (await chatRecord(id))?.thread as T | null ?? null; },
    async setItem<T>(id: string, value: T) {
      const saved = await writeChat(id, storedChatSyncRecord({ key: id, value }));
      if (!saved?.thread) throw new StorageError("STORAGE_INVALID");
      return saved.thread as T;
    },
    async removeItem(id) { await writeChat(id, null); },
    async clear() { for (const id of await rows.keys()) await writeChat(id, null); },
    async iterate<T, R>(iterator: (value: T, key: string, index: number) => R) {
      let index = 0;
      for (const id of await rows.keys()) {
        const row = await chatRecord(id);
        if (!row?.thread) continue;
        const result = iterator(row.thread as T, id, ++index);
        if (result !== undefined) return result;
      }
    },
    async syncRecords() {
      const records: ChatSyncRecord[] = [];
      for (const id of await rows.keys()) {
        const row = await chatRecord(id);
        if (row) records.push(row);
      }
      return records;
    },
    compareSync(expected, next) {
      const before = structuredClone(expected);
      const candidate = structuredClone(next);
      return ordered(async () => {
        if (!chatSyncRecordSchema.safeParse(candidate).success || before && !chatSyncRecordSchema.safeParse(before).success) {
          throw new StorageError("STORAGE_INVALID");
        }
        if (candidate.thread && (await projects.getItem<{ id: string }>(candidate.projectId))?.id !== candidate.projectId) return false;
        const snapshot = await rows.snapshot(candidate.id);
        const current = snapshot.expectedHash === "absent" ? null : readChatRecord(candidate.id, snapshot.value);
        if (!canCompareChatSync(current, before, candidate)) return false;
        if (current && sameChatSyncRecord(current, candidate)) return true;
        return rows.compareItem(candidate.id, candidate.thread ?? candidate, snapshot.expectedHash);
      });
    },
    async deleteThread(id, projectId, updatedAt) { await writeChat(id, { id, projectId, updatedAt, thread: null }); },
  };
  return {
    kind: "browser", state, projects, preferences, images, chats,
    previews: new CanvasCollection(bridge, "previews"),
    media: new CanvasCollection(bridge, "media"),
    imageRecords: new CanvasCollection(bridge, "imageRecords"),
    videoRecords: unavailableCollection,
    audioRecords: unavailableCollection,
    agentRecords: new CanvasCollection(bridge, "agentRecords"),
    works: {
      ...unavailableCollection,
      create: async () => unsupported(),
      syncRecords: async () => [],
      compareSync: async () => unsupported(),
    },
    editAssetLibrary(edits) {
      const patch = assetLibraryEditsSchema.parse(structuredClone(edits));
      return ordered(async () => {
        const existing = await state.getItem<string>(assetLibraryKey);
        const next = applyAssetEdits(existing === null ? null : JSON.parse(existing), patch);
        await state.setItem(assetLibraryKey, JSON.stringify(next));
      });
    },
    async installArchive(input, view) {
      assertArchiveInstall(input, view);
      if (input.target.kind !== "canvas" || input.files.some(({ resource }) => resource.collection !== "images")) unsupported();
      const { target, files } = structuredClone(input);
      if (target.kind !== "canvas") unsupported();
      const document = serializeCanvasDocument(target.document);
      if (document.nodes.some((node) => !["text", "image", "group"].includes(node.type))) unsupported();
      if (await projects.getItem(document.id) !== null) return;
      // Publish the document only after its original images and conversations have durable receipts.
      for (const { resource, blob } of files) await images.setItem(resource.key, blob);
      for (const thread of target.threads) await chats.setItem(thread.id, thread);
      if (view) await preferences.setItem(document.id, structuredClone(view));
      await projects.setItem(document.id, document);
    },
    pluginFiles: () => unavailableCollection,
    pluginData: () => unavailableCollection,
    comparePluginSyncData: async () => unsupported(),
  };
}
