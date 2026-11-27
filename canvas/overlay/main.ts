// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { initializeStorage } from "@workbench/services/storage/runtime";
import { initializeChannels } from "@workbench/services/channels/runtime";
import { initializeModels } from "@workbench/services/api/models/runtime";
import { initializeNetwork } from "@workbench/services/network/runtime";
import { initializeWorkspaceConfig } from "@workbench/services/workspace-config/runtime";
import { initializePlugins } from "@workbench/services/plugins/runtime";
import { defaultWorkspaceConfig } from "@infinite-canvas/shared/workspace-config";
import { DEFAULT_PLUGIN_REGISTRY } from "@infinite-canvas/shared/plugins";
import { createCanvasBridge } from "./bridge";
import { createCanvasStorage } from "./storage";
import { createCanvasChannels } from "./channels";
import { canvasUnsupported } from "./policy";
import { initializeCanvasTranslations } from "./i18n";

async function startCanvas() {
  const bridge = createCanvasBridge(window);
  const session = await bridge.bootstrap();
  initializeStorage(createCanvasStorage(bridge));
  initializeNetwork({ kind: "browser", url: (url) => url });
  initializeWorkspaceConfig({
    load: async () => structuredClone(defaultWorkspaceConfig),
    save: async () => canvasUnsupported(),
    update: async () => canvasUnsupported(),
  });
  initializePlugins({
    list: async () => [],
    config: async () => ({ registry: DEFAULT_PLUGIN_REGISTRY, skipThirdPartyPlugins: true }),
    index: async () => canvasUnsupported(),
    configure: async () => canvasUnsupported(),
    install: async () => canvasUnsupported(),
    inspectPackage: async () => canvasUnsupported(),
    installPackage: async () => canvasUnsupported(),
    remove: async () => canvasUnsupported(),
    enable: async () => canvasUnsupported(),
    source: async () => canvasUnsupported(),
    asset: async () => canvasUnsupported(),
  });
  initializeChannels(await createCanvasChannels(session));
  const { loadChannelConfig, useConfigStore } = await import("@workbench/stores/use-config-store");
  await useConfigStore.persist.rehydrate();
  await loadChannelConfig();
  const { callScriptsReady } = await import("@workbench/stores/use-call-script-store");
  await callScriptsReady;
  const { createCanvasModels } = await import("./models");
  initializeModels(createCanvasModels());
  await initializeCanvasTranslations();
  await import("./bootstrap");
}

void startCanvas().catch(() => {
  // Never send exceptions containing model requests, headers, or credentials back to the host.
  if (window.parent !== window) window.parent.postMessage({ type: "newapi-canvas-error", message: "CANVAS_STARTUP_FAILED" }, location.origin);
});
