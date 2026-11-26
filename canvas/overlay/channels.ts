// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import type { ModelChannel } from "@infinite-canvas/shared/channels";
import type { ChannelAdapter } from "@workbench/services/channels/runtime";
import type { CanvasBootstrap } from "./bridge";
import { canvasGroupID, getCanvasConnection, setCanvasConnection } from "./policy";

export async function createCanvasChannels(bootstrap: CanvasBootstrap): Promise<ChannelAdapter> {
  const response = await fetch(new URL(`${bootstrap.base_url}/models`, location.origin), {
    headers: { Authorization: `Bearer ${bootstrap.api_key}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("CANVAS_MODELS_UNAVAILABLE");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("CANVAS_INVALID_MODELS");
  }
  const { guessCapability } = await import("@workbench/lib/model-utils");
  const names = [...new Set(body.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id) return [];
    return [item.id];
  }))];
  const models: ModelChannel["groups"][number]["models"] = [];
  for (const name of names) {
    const capability = guessCapability(name);
    if (capability === "image" && /gpt|dall[-_]?e/i.test(name)) models.push({ name, capability, scriptId: "openai-image" });
    else if (capability === "text") models.push({ name, capability, scriptId: "openai-text" });
  }
  setCanvasConnection({
    id: "newapi", name: "new-api", baseUrl: location.origin,
    groups: [{ id: canvasGroupID, name: "auto", apiKey: bootstrap.api_key, models }],
  });
  return {
    load: async () => [getCanvasConnection()],
    // The gateway owns connection settings. Imported or edited credentials are never persisted.
    save: async () => [getCanvasConnection()],
    listModels: async () => getCanvasConnection().groups[0].models.map((model) => model.name),
  };
}
