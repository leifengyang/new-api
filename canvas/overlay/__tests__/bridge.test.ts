import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvasBridge } from "../bridge";

function hostFixture() {
  const listeners = new Map<string, EventListener>();
  const requests: Record<string, unknown>[] = [];
  const parent = { postMessage: (message: Record<string, unknown>, origin: string) => {
    assert.equal(origin, "https://gateway.example");
    requests.push(message);
  } };
  const frame = {
    parent,
    location: { origin: "https://gateway.example" },
    addEventListener: (event: string, listener: EventListener) => listeners.set(event, listener),
    removeEventListener: (event: string) => listeners.delete(event),
  };
  const emit = (data: unknown, source: unknown = parent, origin = frame.location.origin) => {
    listeners.get("message")?.({ data, source, origin } as MessageEvent);
  };
  return { bridge: createCanvasBridge(frame as unknown as Window), requests, parent, emit, listeners };
}

test("bootstrap ignores replies from other frames or origins and accepts only its parent", async () => {
  const host = hostFixture();
  const operation = host.bridge.bootstrap();
  const data = { user_id: 7, token_id: 11, api_key: "test-key", base_url: "/v1" };
  const response = { type: "newapi-canvas-response", id: host.requests[0].id, ok: true, data };
  host.emit(response, {}, "https://gateway.example");
  host.emit(response, host.parent, "https://other.example");
  host.emit(response);
  assert.deepEqual(await operation, data);
});

test("bootstrap rejects a host response that points credentials at another API", async () => {
  const host = hostFixture();
  const operation = host.bridge.bootstrap();
  host.emit({ type: "newapi-canvas-response", id: host.requests[0].id, ok: true,
    data: { user_id: 7, token_id: 11, api_key: "test-key", base_url: "https://other.example/v1" } });
  await assert.rejects(operation, /CANVAS_INVALID_BOOTSTRAP/);
});

test("leaving the editor rejects pending storage writes instead of reporting them saved", async () => {
  const host = hostFixture();
  const operation = host.bridge.storage({ path: "/api/canvas/storage/projects/a", method: "PUT", body: new ArrayBuffer(0) });
  host.listeners.get("pagehide")?.({} as Event);
  await assert.rejects(operation, /CANVAS_HOST_DISCONNECTED/);
});

test("storage preserves an authenticated host failure as a failed request", async () => {
  const host = hostFixture();
  const operation = host.bridge.storage({ path: "/api/canvas/storage/images/a", method: "GET" });
  host.emit({ type: "newapi-canvas-response", id: host.requests[0].id, ok: false, error: "Session expired" });
  await assert.rejects(operation, /Session expired/);
});
