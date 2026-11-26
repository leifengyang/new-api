// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import type { ModelChannel, ChannelModel } from "@infinite-canvas/shared/channels";
import type { ModelCall, ModelExecutionConfig } from "@infinite-canvas/shared/model-execution";
import type { ModelCapability } from "@infinite-canvas/shared/models";
import { builtinCallScripts } from "../../../../packages/model-runtime/src/call-scripts/builtin";

let connection: ModelChannel | undefined;
export const canvasGroupID = "newapi-auto";

export function setCanvasConnection(value: ModelChannel) {
  if (connection) throw new Error("CANVAS_ALREADY_INITIALIZED");
  connection = structuredClone(value);
}

export function getCanvasConnection(): ModelChannel {
  if (!connection) throw new Error("CANVAS_NOT_INITIALIZED");
  return structuredClone(connection);
}

export function assertCanvasModel(config: ModelExecutionConfig, capability?: ModelCapability): ChannelModel {
  const group = connection?.groups[0];
  const model = group?.models.find((item) => item.name === config.model);
  if (!connection || !group || !model || config.baseUrl !== connection.baseUrl || config.apiKey !== group.apiKey ||
    config.groupId !== group.id || (capability !== undefined && model.capability !== capability)) {
    throw new Error("CANVAS_MODEL_NOT_AVAILABLE");
  }
  return model;
}

export function assertCanvasCall(call: ModelCall, capability: ModelCapability) {
  const script = assertCanvasScript(call, capability, call.script);
  if (call.scriptId !== script.id) throw new Error("CANVAS_CUSTOM_SCRIPTS_DISABLED");
}

export function assertCanvasScript(config: ModelExecutionConfig, capability: ModelCapability, source: string) {
  const model = assertCanvasModel(config, capability);
  const script = builtinCallScripts.find((item) => item.id === model.scriptId);
  if (!script || source !== script.source || script.capability !== capability) {
    throw new Error("CANVAS_CUSTOM_SCRIPTS_DISABLED");
  }
  return script;
}

export function canvasUnsupported(): never {
  throw new Error("CANVAS_FEATURE_UNAVAILABLE");
}
