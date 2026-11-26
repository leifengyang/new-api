// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
export type CanvasBootstrap = {
  user_id: number;
  token_id: number;
  api_key: string;
  base_url: string;
};

export type CanvasStorageResponse = {
  status: number;
  body: ArrayBuffer;
  contentType: string;
};

export type CanvasRequest = {
  operation: "bootstrap" | "storage";
  path?: string;
  method?: "GET" | "PUT" | "DELETE";
  body?: ArrayBuffer;
  contentType?: string;
  expectedHash?: string;
};

export interface CanvasBridge {
  bootstrap(): Promise<CanvasBootstrap>;
  storage(request: Omit<CanvasRequest, "operation">): Promise<CanvasStorageResponse>;
}

export function createCanvasBridge(frame: Window): CanvasBridge {
  if (frame.parent === frame) throw new Error("CANVAS_HOST_REQUIRED");
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.parent || event.origin !== frame.location.origin) return;
    const message = event.data;
    if (!message || message.type !== "newapi-canvas-response" || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request || typeof message.ok !== "boolean") return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(typeof message.error === "string" ? message.error : "CANVAS_REQUEST_FAILED"));
  };
  frame.addEventListener("message", receive);
  frame.addEventListener("pagehide", () => {
    frame.removeEventListener("message", receive);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("CANVAS_HOST_DISCONNECTED"));
    }
    pending.clear();
  }, { once: true });
  const request = (payload: CanvasRequest): Promise<unknown> => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CANVAS_REQUEST_TIMEOUT"));
    }, 90_000);
    pending.set(id, { resolve, reject, timeout });
    frame.parent.postMessage({ type: "newapi-canvas-request", id, ...payload }, frame.location.origin);
  });
  return {
    async bootstrap() {
      const value = await request({ operation: "bootstrap" }) as Partial<CanvasBootstrap> | undefined;
      if (!value || !Number.isSafeInteger(value.user_id) || Number(value.user_id) < 1 ||
        !Number.isSafeInteger(value.token_id) || Number(value.token_id) < 1 ||
        typeof value.api_key !== "string" || !value.api_key || value.base_url !== "/v1") {
        throw new Error("CANVAS_INVALID_BOOTSTRAP");
      }
      return value as CanvasBootstrap;
    },
    async storage(payload) {
      const value = await request({ ...payload, operation: "storage" }) as Partial<CanvasStorageResponse> | undefined;
      if (!value || !Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 ||
        !(value.body instanceof ArrayBuffer) || typeof value.contentType !== "string") {
        throw new Error("CANVAS_INVALID_STORAGE_RESPONSE");
      }
      return value as CanvasStorageResponse;
    },
  };
}
