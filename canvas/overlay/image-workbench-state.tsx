// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";
import mime from "mime";
import { toast } from "sonner";
import type { CanvasAssetInput } from "@infinite-canvas/plugin-sdk";
import type { StoredOutputImage } from "@infinite-canvas/shared/sync-records";
import { useGroupedImagePreview } from "@workbench/hooks/use-grouped-image-preview";
import { useReferenceImages } from "@workbench/hooks/use-reference-images";
import { useReferencePaste } from "@workbench/hooks/use-reference-paste";
import { subscribeCreateSessionsChanged } from "@workbench/lib/create-sessions-events";
import { useCreateGeneration } from "@workbench/pages/create/use-create-generation";
import type { CreateEntryActions } from "@workbench/pages/create/components/create-entry";
import type { CreateLog, ImageLog } from "@workbench/services/create/logs";
import {
  GenerationRecordDeletion,
  readGenerationRecords,
} from "@workbench/services/generation-records";
import { readImageBlob } from "@workbench/services/image-storage";
import { saveGeneratedAsset } from "@workbench/stores/use-asset-store";
import {
  getModelConfigIssue,
  selectableModelsByCapability,
  useConfigStore,
  useEffectiveConfig,
  type AiConfig,
} from "@workbench/stores/use-config-store";
import type { ReferenceImage } from "@workbench/types/image";

type ImageOptions = Partial<Pick<AiConfig, "quality" | "size" | "count" | "background">>;

export function useImageWorkbench() {
  const { t } = useTranslation();
  const defaults = useEffectiveConfig();
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const [options, setOptions] = useState<ImageOptions>({});
  const config = useMemo(() => ({ ...defaults, ...options }), [defaults, options]);
  const imageModels = useMemo(() => selectableModelsByCapability(config, "image"), [config]);
  const model = config.imageModel || config.model;
  const modelReady = imageModels.includes(model) && !getModelConfigIssue(config, model);
  const [logs, setLogs] = useState<ImageLog[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletion, setDeletion] = useState<GenerationRecordDeletion>();
  const [deleteError, setDeleteError] = useState("");
  const page = useRef(new AbortController());
  const draft = useRef(new AbortController());
  const pending = useRef({ generation: false, references: 0, deletion: false });
  const historyRequest = useRef<AbortController | undefined>(undefined);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const references = useReferenceImages(undefined, { registerAssets: true });
  const preview = useGroupedImagePreview();

  useLayoutEffect(() => {
    const controller = new AbortController();
    page.current = controller;
    draft.current = new AbortController();
    return () => {
      controller.abort();
      draft.current.abort();
      historyRequest.current?.abort();
    };
  }, []);

  const upsert = useCallback((log: CreateLog) => {
    if (page.current.signal.aborted || log.kind !== "image") return;
    setLogs((current) => [log, ...current.filter((item) => item.id !== log.id)]);
  }, []);
  const update = useCallback((id: string, updater: (log: CreateLog) => CreateLog) => {
    if (page.current.signal.aborted) return;
    setLogs((current) =>
      current.map((log) => {
        if (log.id !== id) return log;
        const next = updater(log);
        return next.kind === "image" ? next : log;
      }),
    );
  }, []);
  const remove = useCallback((ids: string[]) => {
    if (page.current.signal.aborted) return;
    setLogs((current) => current.filter((log) => !ids.includes(log.id)));
  }, []);
  const generation = useCreateGeneration({ upsert, update, remove }, page, config);

  const loadHistory = useCallback(async () => {
    if (pending.current.generation) return;
    historyRequest.current?.abort();
    const request = new AbortController();
    historyRequest.current = request;
    const signal = AbortSignal.any([page.current.signal, request.signal]);
    setLoading(true);
    setHistoryError("");
    try {
      const records = await readGenerationRecords<ImageLog>("image", signal);
      if (signal.aborted) return;
      setLogs(records.map((log) => ({ ...log, kind: "image" })));
      setSelectedIds((ids) =>
        ids.filter((id) => records.some((log) => log.id === id && log.status !== "pending")),
      );
      setActiveId((id) => (records.some((log) => log.id === id) ? id : undefined));
    } catch {
      if (!signal.aborted) setHistoryError(t("Unable to load image history. Please retry."));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadHistory();
    return subscribeCreateSessionsChanged(() => {
      void loadHistory();
    });
  }, [loadHistory]);

  async function addReferences(files?: File[]) {
    if (page.current.signal.aborted || pending.current.generation || pending.current.deletion) {
      return;
    }
    const signal = AbortSignal.any([page.current.signal, draft.current.signal]);
    pending.current.references++;
    setReferenceBusy(true);
    try {
      if (files) await references.addReferenceFiles(files, signal);
      else await references.pasteReferenceImages(signal);
    } finally {
      pending.current.references--;
      if (!page.current.signal.aborted) setReferenceBusy(pending.current.references > 0);
    }
  }
  useReferencePaste(
    (files) => {
      void addReferences(files);
    },
    () => {
      void addReferences();
    },
  );

  function newDraft() {
    if (pending.current.generation) return;
    draft.current.abort();
    draft.current = new AbortController();
    preview.close();
    setActiveId(undefined);
    setPrompt("");
    references.setReferences([]);
  }

  async function reuse(log: ImageLog) {
    if (pending.current.generation) return;
    draft.current.abort();
    draft.current = new AbortController();
    const signal = AbortSignal.any([page.current.signal, draft.current.signal]);
    setActiveId(log.id);
    setPrompt(log.prompt);
    setOptions({
      quality: log.config.quality,
      size: log.config.size,
      count: log.config.count,
      background: log.config.background ?? "auto",
    });
    updateConfig("imageModel", log.model);
    references.setReferences([]);
    pending.current.references++;
    setReferenceBusy(true);
    try {
      await references.acceptReferences(log.references, signal, "replace");
    } finally {
      pending.current.references--;
      if (!page.current.signal.aborted) setReferenceBusy(pending.current.references > 0);
    }
  }

  async function generate(log?: ImageLog) {
    if (
      page.current.signal.aborted ||
      pending.current.generation ||
      pending.current.references ||
      pending.current.deletion ||
      loading ||
      historyError
    ) {
      return;
    }
    const text = (log?.prompt ?? prompt).trim();
    const requestConfig = log
      ? {
          ...config,
          ...log.config,
          background: log.config.background ?? "auto",
          model: log.model,
          imageModel: log.model,
        }
      : config;
    const requestModel = requestConfig.imageModel || requestConfig.model;
    if (!text) return;
    if (!imageModels.includes(requestModel) || getModelConfigIssue(requestConfig, requestModel)) {
      toast.error(t("Select an available image model before generating."));
      return;
    }
    pending.current.generation = true;
    setSubmitting(true);
    try {
      await generation.generateImage({
        prompt: text,
        references: log?.references ?? references.references,
        sessionId: crypto.randomUUID(),
        overrides: log
          ? {
              ...log.config,
              background: log.config.background ?? "auto",
              model: log.model,
              imageModel: log.model,
            }
          : undefined,
        onLog: (created) => {
          if (!page.current.signal.aborted) setActiveId(created.id);
        },
      });
    } catch {
      if (!page.current.signal.aborted) toast.error(t("Image generation failed. Please retry."));
    } finally {
      pending.current.generation = false;
      if (!page.current.signal.aborted) setSubmitting(false);
    }
  }

  function requestDeletion(trigger: HTMLButtonElement) {
    if (pending.current.generation || pending.current.deletion) return;
    const ids = selectedIds.filter((id) =>
      logs.some((log) => log.id === id && log.status !== "pending"),
    );
    if (!ids.length) return;
    deleteTrigger.current = trigger;
    setDeleteError("");
    setDeletion(new GenerationRecordDeletion("image", ids));
  }

  async function deleteSelected() {
    if (!deletion || pending.current.deletion || pending.current.generation) return;
    pending.current.deletion = true;
    setDeleting(true);
    setDeleteError("");
    try {
      await deletion.remove(page.current.signal);
      if (page.current.signal.aborted) return;
      remove([...deletion.ids]);
      setSelectedIds((ids) => ids.filter((id) => !deletion.ids.includes(id)));
      if (activeId && deletion.ids.includes(activeId)) newDraft();
      setDeletion(undefined);
    } catch {
      if (!page.current.signal.aborted) {
        const message = t("Some image records could not be deleted. Please retry.");
        setDeleteError(message);
        toast.error(message);
        await loadHistory();
      }
    } finally {
      pending.current.deletion = false;
      if (!page.current.signal.aborted) setDeleting(false);
    }
  }

  function showReferences(image: ReferenceImage, items = references.references) {
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === image.id),
    );
    preview.open(
      items.map((item) => ({
        id: item.id,
        alt: item.name,
        storageKey: item.storageKey,
        url: item.url || item.dataUrl,
        signal: page.current.signal,
      })),
      index,
    );
  }

  async function insertAsset(asset: CanvasAssetInput, signal: AbortSignal) {
    if (pending.current.generation || signal.aborted) return false;
    if (asset.kind === "text") {
      setPrompt(asset.content);
      return true;
    }
    if (asset.kind !== "image") {
      toast.error(t("Choose a text or image asset."));
      return false;
    }
    pending.current.references++;
    setReferenceBusy(true);
    try {
      return await references.acceptReferences(
        [
          {
            id: crypto.randomUUID(),
            name: asset.title,
            type: asset.mimeType,
            storageKey: asset.storageKey,
            dataUrl: asset.url,
          },
        ],
        AbortSignal.any([signal, page.current.signal, draft.current.signal]),
        "append",
      );
    } finally {
      pending.current.references--;
      if (!page.current.signal.aborted) setReferenceBusy(pending.current.references > 0);
    }
  }

  const actions: CreateEntryActions = {
    signal: page.current.signal,
    onPreviewImage(image, items = [image]) {
      preview.open(
        items.map((item, index) => ({
          id: item.id,
          alt: t("Generated image {{number}}", { number: index + 1 }),
          storageKey: item.storageKey,
          url: item.dataUrl,
          signal: page.current.signal,
        })),
        Math.max(
          0,
          items.findIndex((item) => item.id === image.id),
        ),
      );
    },
    onPreviewReference: showReferences,
    async onAddReference(image: StoredOutputImage) {
      if (pending.current.generation) return;
      pending.current.references++;
      setReferenceBusy(true);
      try {
        await references.acceptReferences(
          [
            {
              id: crypto.randomUUID(),
              name: t("Generated image"),
              type: image.mimeType || "image/png",
              storageKey: image.storageKey,
              dataUrl: image.dataUrl,
            },
          ],
          AbortSignal.any([page.current.signal, draft.current.signal]),
          "append",
        );
      } finally {
        pending.current.references--;
        if (!page.current.signal.aborted) setReferenceBusy(pending.current.references > 0);
      }
    },
    async onSaveImage(log, image) {
      try {
        const saved = await saveGeneratedAsset({
          kind: "image",
          title: log.title,
          coverUrl: "",
          source: "image-workbench",
          data: {
            storageKey: image.storageKey,
            dataUrl: image.dataUrl,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            mimeType: image.mimeType,
          },
          metadata: { source: "image-workbench", prompt: log.prompt },
        });
        if (!page.current.signal.aborted) {
          if (saved) toast.success(t("Added to assets"));
          else toast.error(t("Unable to save the image to assets. Please retry."));
        }
      } catch {
        if (!page.current.signal.aborted) {
          toast.error(t("Unable to save the image to assets. Please retry."));
        }
      }
    },
    async onDownloadImage(image) {
      const signal = page.current.signal;
      try {
        const blob = await readImageBlob(image.storageKey, image.dataUrl, { signal });
        signal.throwIfAborted();
        const extension = mime.getExtension(blob.type || image.mimeType) || "png";
        saveAs(blob, `image-${image.id.slice(0, 8)}.${extension}`);
      } catch {
        if (!signal.aborted) toast.error(t("Unable to download this image. Please retry."));
      }
    },
    onReuse(log) {
      if (log.kind === "image") void reuse(log);
    },
    onRegenerate(log) {
      if (log.kind === "image") void generate(log);
    },
    onSaveVideo: async () => {},
    onDownloadVideo: async () => {},
    onDownloadAudio: async () => {},
    onWaitVideo: () => {},
  };

  return {
    config,
    imageModels,
    model,
    modelReady,
    logs,
    active: logs.find((log) => log.id === activeId),
    selectedIds,
    setSelectedIds,
    loading,
    historyError,
    loadHistory,
    prompt,
    setPrompt,
    submitting,
    referenceBusy,
    deleting,
    deletion,
    deleteError,
    deleteTrigger,
    references,
    preview,
    actions,
    addReferences,
    newDraft,
    reuse,
    generate,
    requestDeletion,
    deleteSelected,
    showReferences,
    insertAsset,
    pageSignal: page.current.signal,
    selectModel: (value: string) => updateConfig("imageModel", value),
    updateOptions: (key: keyof ImageOptions, value: string) =>
      setOptions((current) => ({ ...current, [key]: value })),
    closeDeletion: () => {
      if (!pending.current.deletion) {
        setDeletion(undefined);
        setDeleteError("");
      }
    },
  };
}
