// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { createBrowserModels } from "@workbench/services/api/models/browser";
import type { ModelAdapter } from "@workbench/services/api/models/types";
import { assertCanvasCall, assertCanvasModel, canvasUnsupported } from "./policy";

export function createCanvasModels(): ModelAdapter {
  const browser = createBrowserModels();
  return {
    generateImages(request, options) {
      assertCanvasCall(request.call, "image");
      return browser.generateImages(request, options);
    },
    generateText(request, options) {
      assertCanvasCall(request.call, "text");
      return browser.generateText(request, options);
    },
    async fetchText(config, protocol, url, init) {
      assertCanvasModel(config, "text");
      const target = new URL(url, location.origin);
      if (protocol !== "responses" || target.origin !== location.origin || target.pathname !== "/v1/responses" || target.search || target.hash) {
        throw new Error("CANVAS_MODEL_NOT_AVAILABLE");
      }
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${config.apiKey}`);
      return browser.fetchText(config, protocol, target.href, { ...init, headers, credentials: "omit", redirect: "error" });
    },
    generateAudio: async () => canvasUnsupported(),
    createVideoTask: async () => canvasUnsupported(),
    queryVideoTask: async () => canvasUnsupported(),
  };
}
