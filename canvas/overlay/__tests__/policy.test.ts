import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCallScripts } from "../../../../../packages/model-runtime/src/call-scripts/builtin";
import { assertCanvasCall, assertCanvasModel, getCanvasConnection, setCanvasConnection } from "../policy";

const script = builtinCallScripts.find((item) => item.id === "openai-image");
assert.ok(script);
const call = {
  groupId: "newapi-auto", model: "gpt-image-1", baseUrl: "https://gateway.example",
  apiKey: "sk-canvas-test", systemPrompt: "", reasoningEffort: "auto" as const,
  scriptId: script.id, script: script.source,
};
setCanvasConnection({
  id: "newapi", name: "new-api", baseUrl: call.baseUrl,
  groups: [{ id: call.groupId, name: "auto", apiKey: call.apiKey,
    models: [{ name: call.model, capability: "image", scriptId: script.id }] }],
});

test("the available image model can execute its built-in image script", () => {
  assert.doesNotThrow(() => assertCanvasCall(call, "image"));
});

test("imported custom code cannot execute under the built-in script ID", () => {
  assert.throws(() => assertCanvasCall({ ...call, script: "fetch('https://other.example')" }, "image"), /CANVAS_CUSTOM_SCRIPTS_DISABLED/);
});

test("a modified endpoint or different credential cannot receive a model request", () => {
  assert.throws(() => assertCanvasCall({ ...call, baseUrl: "https://other.example" }, "image"), /CANVAS_MODEL_NOT_AVAILABLE/);
  assert.throws(() => assertCanvasCall({ ...call, apiKey: "another-account-key" }, "image"), /CANVAS_MODEL_NOT_AVAILABLE/);
});

test("models missing from the token model list cannot be invoked", () => {
  assert.throws(() => assertCanvasModel({ ...call, model: "unavailable-model" }), /CANVAS_MODEL_NOT_AVAILABLE/);
});

test("editing returned channel preferences cannot mutate the authorized connection", () => {
  const edited = getCanvasConnection();
  edited.baseUrl = "https://other.example";
  edited.groups[0].models.push({ name: "unavailable-model", capability: "image" });
  assert.equal(getCanvasConnection().baseUrl, call.baseUrl);
  assert.throws(() => assertCanvasModel({ ...call, model: "unavailable-model" }), /CANVAS_MODEL_NOT_AVAILABLE/);
});
