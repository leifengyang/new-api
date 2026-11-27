import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CanvasBridge, CanvasRequest, CanvasStorageResponse } from "../bridge";
import { createCanvasStorage } from "../storage";
import { StorageError, storedChatSyncRecord } from "@infinite-canvas/shared/storage-data";
import type { ArchiveThread } from "@infinite-canvas/shared/chat";

import { buildImageLog, serializeLog, type ImageLog } from "@workbench/services/create/logs";
import type { AiConfig } from "@workbench/stores/use-config-store";
import { initializeStorage } from "@workbench/services/storage/runtime";
import { readGenerationRecords, updateGenerationRecord } from "@workbench/services/generation-records";
import { subscribeCreateSessionsChanged } from "@workbench/lib/create-sessions-events";

function remoteFixture() {
  const values = new Map<string, { body: ArrayBuffer; contentType: string }>();
  const encoder = new TextEncoder();
  const requests: Omit<CanvasRequest, "operation">[] = [];
  const bridge: CanvasBridge = {
    bootstrap: async () => ({ user_id: 1, token_id: 1, api_key: "test-key", base_url: "/v1" }),
    async storage(request): Promise<CanvasStorageResponse> {
      requests.push(request);
      const path = request.path;
      assert.ok(path);
      if (request.method === "PUT") {
        assert.ok(request.body);
        assert.ok(request.contentType);
        if (request.expectedHash !== undefined) {
          const current = values.get(path);
          const expectedHash = current ? createHash("sha256").update(new Uint8Array(current.body)).digest("hex") : "absent";
          if (request.expectedHash !== expectedHash) return { status: 412, body: new ArrayBuffer(0), contentType: "" };
        }
        values.set(path, { body: request.body, contentType: request.contentType });
        return { status: 204, body: new ArrayBuffer(0), contentType: "" };
      }
      if (request.method === "DELETE") {
        values.delete(path);
        return { status: 204, body: new ArrayBuffer(0), contentType: "" };
      }
      if (path.split("/").length === 5) {
        const keys = [...values.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => decodeURIComponent(key.slice(path.length + 1)));
        return { status: 200, body: encoder.encode(JSON.stringify({ success: true, data: { keys } })).buffer, contentType: "application/json" };
      }
      const value = values.get(path);
      return value ? { status: 200, ...value } : { status: 404, body: new ArrayBuffer(0), contentType: "" };
    },
  };
  return { storage: createCanvasStorage(bridge), bridge, requests, values };
}

const chatProject = { schemaVersion: 1, id: "project", title: "Canvas", createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z", nodes: [], connections: [] };

function agentThread(text = "Check the connection"): ArchiveThread {
  return {
    id: "conversation", projectId: "project", title: text, updatedAt: "2026-11-26T00:00:01.000Z",
    items: [{ id: `user-${text}`, role: "user", text }],
    messages: [{ role: "user", content: text }],
    contextMessages: [{ role: "user", content: text }],
  };
}

test("cloud image and preferences collections restore the original bytes and JSON", async () => {
  const remote = remoteFixture();
  const image = new Blob([new Uint8Array([1, 7, 8])], { type: "image/png" });
  await remote.storage.images.setItem("reference/1", image);
  await remote.storage.preferences.setItem("view", { x: 5, y: 9 });
  const restored = await remote.storage.images.getItem<Blob>("reference/1");
  assert.ok(restored);
  assert.equal(restored.type, "image/png");
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), new Uint8Array([1, 7, 8]));
  assert.deepEqual(await remote.storage.preferences.getItem("view"), { x: 5, y: 9 });
});

test('image history restores generation settings and durable references without copying connection credentials', async () => {
  const remote = remoteFixture()
  const config = {
    model: 'newapi::auto::gpt-image-1',
    imageModel: 'newapi::auto::gpt-image-1',
    quality: 'high',
    size: '1536x1024',
    count: '2',
    background: 'transparent',
    apiKey: 'fixture-secret',
    baseUrl: 'https://fixture.invalid',
  } as AiConfig
  const log = buildImageLog(
    'Poster\nwith transparent background',
    config.imageModel,
    config,
    [
      {
        id: 'reference',
        name: 'photo.png',
        type: 'image/png',
        storageKey: 'reference',
        url: 'blob:temporary',
      },
    ],
    'session',
    2
  )
  await remote.storage.imageRecords.setItem(log.id, serializeLog(log))
  const reopened = createCanvasStorage(remote.bridge)
  const saved = await reopened.imageRecords.getItem<ImageLog>(log.id)
  assert.ok(saved)
  assert.equal(saved.prompt, log.prompt)
  assert.deepEqual(saved.config, {
    model: config.model,
    imageModel: config.imageModel,
    quality: 'high',
    size: '1536x1024',
    count: '2',
    background: 'transparent',
  })
  assert.deepEqual(saved.references, [
    {
      id: 'reference',
      name: 'photo.png',
      type: 'image/png',
      storageKey: 'reference',
    },
  ])
  assert.equal(saved.slots.length, 2)
  assert.equal(JSON.stringify(saved).includes('fixture-secret'), false)
  await reopened.imageRecords.removeItem(log.id)
  assert.equal(await remote.storage.imageRecords.getItem(log.id), null)
})

test('reopened image history observes confirmed result updates and marks unfinished browser requests interrupted', async () => {
  const remote = remoteFixture()
  initializeStorage(remote.storage)
  const config = {
    model: 'gpt-image-1',
    imageModel: 'gpt-image-1',
    quality: 'auto',
    size: '1024x1024',
    count: '1',
    background: 'auto',
  } as AiConfig
  const log = buildImageLog('Landscape', config.model, config, [], 'session', 1)
  await remote.storage.imageRecords.setItem(log.id, log)
  const reopened = await readGenerationRecords<ImageLog>('image')
  assert.equal(reopened[0].status, 'interrupted')
  const observed: string[] = []
  const unsubscribe = subscribeCreateSessionsChanged(() =>
    observed.push('updated')
  )
  try {
    assert.equal(
      await updateGenerationRecord<ImageLog>(
        'image',
        log.id,
        log.generationId,
        (row) => ({ ...row, status: 'success', successCount: 1 })
      ),
      true
    )
    assert.equal(
      (await readGenerationRecords<ImageLog>('image'))[0].status,
      'success'
    )
    assert.deepEqual(observed, ['updated'])
    const requestStorage = remote.bridge.storage
    remote.bridge.storage = async (request) => request.method === 'PUT'
      ? { status: 503, body: new ArrayBuffer(0), contentType: '' }
      : requestStorage(request)
    await assert.rejects(
      updateGenerationRecord<ImageLog>(
        'image',
        log.id,
        log.generationId,
        (row) => ({ ...row, status: 'failed' })
      )
    )
    assert.deepEqual(observed, ['updated'])
  } finally {
    unsubscribe()
  }
})

test("a rejected cloud save is not acknowledged as success", async () => {
  const remote = remoteFixture();
  remote.bridge.storage = async () => ({ status: 403, body: new ArrayBuffer(0), contentType: "" });
  await assert.rejects(remote.storage.preferences.setItem("view", { x: 4 }));
});

test("a full cloud storage response rejects the save with the translated quota message", async () => {
  const remote = remoteFixture();
  const message = "Your canvas storage is full. Delete unused projects or assets, or contact your administrator.";
  remote.bridge.storage = async () => ({
    status: 409,
    body: new TextEncoder().encode(JSON.stringify({ success: false, code: "CANVAS_STORAGE_QUOTA_EXCEEDED", message })).buffer,
    contentType: "application/json; charset=utf-8",
  });
  await assert.rejects(remote.storage.preferences.setItem("view", { x: 4 }), {
    code: "STORAGE_UNAVAILABLE",
    message,
  });
  assert.equal(remote.values.size, 0);
});

test("cloud listing, reads, and deletes preserve a translated canvas error", async () => {
  const remote = remoteFixture();
  const message = "The canvas storage request failed. Please try again.";
  remote.bridge.storage = async () => ({
    status: 503,
    body: new TextEncoder().encode(JSON.stringify({ success: false, code: "CANVAS_STORAGE_FAILED", message })).buffer,
    contentType: "application/json",
  });
  await assert.rejects(remote.storage.preferences.iterate(() => undefined), { message });
  await assert.rejects(remote.storage.preferences.getItem("view"), { message });
  await assert.rejects(remote.storage.preferences.removeItem("view"), { message });
});

test("malformed, oversized, and non-canvas error bodies fall back to the safe storage error", async () => {
  const generic = new StorageError("STORAGE_UNAVAILABLE").message;
  const cases = [
    { body: "<html>proxy error</html>", contentType: "text/html" },
    { body: "{invalid", contentType: "application/json" },
    { body: JSON.stringify({ success: false, code: "CANVAS_STORAGE_FAILED", message: "x".repeat(65_536) }), contentType: "application/json" },
    { body: JSON.stringify({ success: false, code: "CANVAS_STORAGE_FAILED", message: "x".repeat(1025) }), contentType: "application/json" },
    { body: JSON.stringify({ success: false, code: "PROXY_ERROR", message: "untrusted internal detail" }), contentType: "application/json" },
  ];
  for (const example of cases) {
    const remote = remoteFixture();
    remote.bridge.storage = async () => ({ status: 502, body: new TextEncoder().encode(example.body).buffer, contentType: example.contentType });
    await assert.rejects(remote.storage.preferences.setItem("view", { x: 4 }), { message: generic });
  }
});

test("custom scripts and executable plugin payloads cannot be persisted through the editor", async () => {
  const remote = remoteFixture();
  await assert.rejects(remote.storage.state.setItem("infinite-canvas:call_scripts", "untrusted source"));
  await assert.rejects(remote.storage.pluginData("plugin-manager").setItem("installed", ["untrusted"]));
  assert.equal(await remote.storage.state.getItem("infinite-canvas:call_scripts"), null);
  assert.equal(remote.requests.length, 0);
});

test("collection iteration returns saved objects and stops when the caller returns a result", async () => {
  const remote = remoteFixture();
  await remote.storage.preferences.setItem("a", 1);
  await remote.storage.preferences.setItem("b", 2);
  const entries: unknown[] = [];
  const result = await remote.storage.preferences.iterate((value, key) => {
    entries.push([key, value]);
    return "found";
  });
  assert.equal(result, "found");
  assert.deepEqual(entries, [["a", 1]]);
});

test("the assistant confirms its first user message before receiving and saving a reply", async () => {
  const remote = remoteFixture();
  await remote.storage.projects.setItem("project", chatProject);
  const thread = agentThread();
  const next = storedChatSyncRecord({ key: thread.id, value: thread });
  assert.equal(await remote.storage.chats.compareSync(null, next), true);
  assert.deepEqual(await remote.storage.chats.getItem(thread.id), thread);
  const replied: ArchiveThread = {
    ...thread, updatedAt: "2026-11-26T00:00:02.000Z",
    items: [...thread.items, { id: "reply", role: "assistant", text: "Connected", status: "done" }],
    messages: [...thread.messages, { role: "assistant", content: "Connected" }],
  };
  await remote.storage.chats.setItem(thread.id, replied);
  assert.deepEqual(await remote.storage.chats.getItem(thread.id), replied);
});

test("two editors cannot both confirm different first messages in the same conversation", async () => {
  const remote = remoteFixture();
  const other = createCanvasStorage(remote.bridge);
  await remote.storage.projects.setItem("project", chatProject);
  const threads = [agentThread("First editor"), agentThread("Second editor")];
  const accepted = await Promise.all(threads.map((thread, index) => (index ? other : remote.storage).chats.compareSync(null, storedChatSyncRecord({ key: thread.id, value: thread }))));
  assert.deepEqual(accepted.toSorted(), [false, true]);
  assert.deepEqual(await remote.storage.chats.getItem("conversation"), threads[accepted.indexOf(true)]);
});

test("confirmation requires a saved project and cannot overwrite a newer conversation baseline", async () => {
  const remote = remoteFixture();
  const thread = agentThread();
  const before = storedChatSyncRecord({ key: thread.id, value: thread });
  assert.equal(await remote.storage.chats.compareSync(null, before), false);
  assert.equal(await remote.storage.chats.getItem(thread.id), null);
  await remote.storage.projects.setItem("project", chatProject);
  assert.equal(await remote.storage.chats.compareSync(null, before), true);
  const newer = { ...thread, updatedAt: "2026-11-26T00:00:03.000Z", title: "Another editor's changes" };
  await remote.storage.chats.setItem(thread.id, newer);
  const delayed = storedChatSyncRecord({ key: thread.id, value: { ...thread, updatedAt: "2026-11-26T00:00:04.000Z", title: "Stale submission" } });
  assert.equal(await remote.storage.chats.compareSync(before, delayed), false);
  assert.deepEqual(await remote.storage.chats.getItem(thread.id), newer);
});

test("a reply racing with another editor's deletion cannot resurrect the conversation", async () => {
  const remote = remoteFixture();
  const other = createCanvasStorage(remote.bridge);
  const thread = agentThread();
  await remote.storage.chats.setItem(thread.id, thread);
  const send = remote.bridge.storage;
  let deleted = false;
  remote.bridge.storage = async (request) => {
    if (!deleted && request.method === "PUT" && request.path?.includes("/chats/")) {
      deleted = true;
      await other.chats.deleteThread(thread.id, thread.projectId, "2026-11-26T00:00:03.000Z");
    }
    return send(request);
  };
  await assert.rejects(remote.storage.chats.setItem(thread.id, { ...thread, updatedAt: "2026-11-26T00:00:02.000Z", title: "Delayed reply" }), { code: "STORAGE_CHAT_DELETED" });
  assert.equal(await remote.storage.chats.getItem(thread.id), null);
});

test("continuous concurrent changes stop after three conditional attempts without confirming a save", async () => {
  const remote = remoteFixture();
  const send = remote.bridge.storage;
  let attempts = 0;
  remote.bridge.storage = async (request) => {
    if (request.method === "PUT" && request.path?.includes("/chats/")) {
      attempts++;
      return { status: 412, body: new ArrayBuffer(0), contentType: "" };
    }
    return send(request);
  };
  await assert.rejects(remote.storage.chats.setItem("conversation", agentThread()), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(attempts, 3);
  assert.equal(await remote.storage.chats.getItem("conversation"), null);
});
