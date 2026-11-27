// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, FolderOpen, History, ImagePlus, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { Textarea } from "@infinite-canvas/plugin-sdk/ui/textarea";
import {
  GenerationHistory,
  GenerationWorkspaceSheet,
  DeleteGenerationDialog,
} from "@workbench/components/generation-history";
import { ImageSettingsPanel } from "@workbench/components/image-settings-panel";
import { ModelPicker } from "@workbench/components/model-picker";
import { ImageThumbnail } from "@workbench/components/image-thumbnail";
import { PromptSelectDialog } from "@workbench/components/prompts/prompt-select-dialog";
import { AssetPickerModal } from "@workbench/components/canvas/asset-picker-modal";
import { ImagePreviewGroup } from "@workbench/components/ui/image-preview-group";
import { ListEmpty } from "@workbench/components/ui/list-empty";
import { CreateEntryResults } from "@workbench/pages/create/components/create-entry";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import { modelOptionName } from "@workbench/stores/use-config-store";
import { ImageWorkbenchReferences } from "./image-workbench-references";
import { useImageWorkbench } from "./image-workbench-state";
import { toIntlLocale } from "./host-languages";

export default function ImageWorkbench() {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language);
  const workbench = useImageWorkbench();
  const theme = canvasThemes[useThemeStore((state) => state.theme)];
  const [showHistory, setShowHistory] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const busy = workbench.submitting || workbench.deleting;
  const disabled =
    busy ||
    workbench.loading ||
    Boolean(workbench.historyError) ||
    workbench.referenceBusy ||
    !workbench.modelReady ||
    !workbench.prompt.trim();
  const history = (
    <>
      {workbench.loading && (
        <p role="status" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {t("Loading image history…")}
        </p>
      )}
      {workbench.historyError && (
        <div role="alert" className="mb-4 space-y-2 text-sm text-destructive">
          <p>{workbench.historyError}</p>
          <Button
            type="button"
            variant="outline"
            disabled={workbench.loading || busy}
            onClick={() => {
              void workbench.loadHistory();
            }}
          >
            {t("Retry")}
          </Button>
        </div>
      )}
      <GenerationHistory
        logs={workbench.logs}
        activeLogId={workbench.active?.id}
        selectedLogIds={workbench.selectedIds}
        onSelectedLogIdsChange={workbench.setSelectedIds}
        onCreateSession={() => {
          workbench.newDraft();
          setShowHistory(false);
        }}
        onDeleteSelected={workbench.requestDeletion}
        onPreviewLog={(log) => {
          void workbench.reuse(log);
          setShowHistory(false);
        }}
        renderLog={(log) => (
          <div className="space-y-2 pl-6">
            <p className="truncate text-sm font-medium">{log.title}</p>
            <p className="truncate text-xs text-muted-foreground">{modelOptionName(log.model)}</p>
            <p className="text-xs text-muted-foreground">
              {new Date(log.createdAt).toLocaleString(locale)}
            </p>
            <div className="flex items-center gap-2">
              {log.images
                .slice(0, 3)
                .map((image) =>
                  image.storageKey ? (
                    <ImageThumbnail
                      key={image.id}
                      storageKey={image.storageKey}
                      alt={log.title}
                      className="size-10 rounded"
                    />
                  ) : (
                    <img
                      key={image.id}
                      src={image.dataUrl}
                      alt={log.title}
                      className="size-10 rounded object-cover"
                    />
                  ),
                )}
              {log.status === "pending" && (
                <span role="status" className="text-xs text-muted-foreground">
                  {t("Generating…")}
                </span>
              )}
              {log.status === "failed" && (
                <span className="text-xs text-destructive">{t("Failed")}</span>
              )}
              {log.status === "interrupted" && (
                <span className="text-xs text-muted-foreground">{t("Interrupted")}</span>
              )}
            </div>
          </div>
        )}
      />
    </>
  );

  return (
    <main
      aria-label={t("Image workbench")}
      className="generation-workspace-controls h-full min-h-0 overflow-y-auto bg-background p-3 text-foreground xl:overflow-hidden"
    >
      <div className="grid min-h-full min-w-0 gap-3 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(210px,0.8fr)_minmax(340px,1.15fr)_minmax(360px,1.6fr)]">
        <aside
          aria-label={t("Image generation history")}
          className="hidden min-h-0 overflow-y-auto rounded-xl border bg-card p-4 xl:block"
        >
          {history}
        </aside>
        <section
          aria-labelledby="image-workbench-heading"
          className="min-w-0 rounded-xl border bg-card p-4 sm:p-5 xl:min-h-0 xl:overflow-y-auto"
        >
          <div className="mb-6 flex items-center justify-between gap-2">
            <h1 id="image-workbench-heading" className="text-2xl font-semibold">
              {t("Image workbench")}
            </h1>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="xl:hidden"
              onClick={() => setShowHistory(true)}
            >
              <History aria-hidden className="size-4" />
              {t("History")}
            </Button>
          </div>
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="image-workbench-prompt" className="text-base font-semibold">
                  {t("Prompt")}
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setShowPrompts(true)}
                  >
                    <BookOpen aria-hidden className="size-4" />
                    {t("Prompt library")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setShowAssets(true)}
                  >
                    <FolderOpen aria-hidden className="size-4" />
                    {t("My assets")}
                  </Button>
                </div>
              </div>
              <Textarea
                id="image-workbench-prompt"
                value={workbench.prompt}
                disabled={busy}
                onChange={(event) => workbench.setPrompt(event.target.value)}
                placeholder={t("Describe the subject, style, composition, lighting, and purpose.")}
                className="min-h-44 resize-y"
              />
            </div>
            <ImageWorkbenchReferences
              images={workbench.references.references}
              busy={workbench.referenceBusy}
              disabled={busy}
              onFiles={workbench.addReferences}
              onPaste={() => workbench.addReferences()}
              onRemove={(id) =>
                workbench.references.setReferences((items) =>
                  items.filter((item) => item.id !== id),
                )
              }
              onPreview={workbench.showReferences}
            />
            <fieldset disabled={busy || !workbench.imageModels.length} className="space-y-3">
              <label htmlFor="image-workbench-model" className="text-base font-semibold">
                {t("Model")}
              </label>
              <ModelPicker
                id="image-workbench-model"
                capability="image"
                config={workbench.config}
                value={workbench.model}
                onChange={workbench.selectModel}
                fullWidth
              />
              {!workbench.modelReady && (
                <p role="status" className="text-sm text-muted-foreground">
                  {workbench.imageModels.length
                    ? t("Select an available image model before generating.")
                    : t("No image models are available for your account.")}
                </p>
              )}
            </fieldset>
            <fieldset disabled={busy}>
              <ImageSettingsPanel
                config={workbench.config}
                onConfigChange={workbench.updateOptions}
                theme={theme}
                showTitle={false}
                className="w-full space-y-5"
              />
            </fieldset>
            <Button
              type="button"
              size="lg"
              className="w-full"
              disabled={disabled}
              onClick={() => {
                if (!disabled) void workbench.generate();
              }}
            >
              {workbench.submitting ? (
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
              ) : (
                <ImagePlus aria-hidden className="size-4" />
              )}
              {workbench.submitting ? t("Generating…") : t("Generate images")}
            </Button>
          </form>
        </section>
        <section
          aria-labelledby="image-workbench-results"
          className="min-h-80 min-w-0 rounded-xl border bg-card p-4 sm:p-5 xl:min-h-0 xl:overflow-y-auto"
        >
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
            <h2 id="image-workbench-results" className="text-xl font-semibold">
              {t("Generation results")}
            </h2>
            {workbench.active && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || workbench.referenceBusy}
                onClick={() => {
                  if (workbench.active) void workbench.reuse(workbench.active);
                }}
              >
                <RotateCcw aria-hidden className="size-4" />
                {t("Reuse settings")}
              </Button>
            )}
          </div>
          {workbench.active ? (
            <CreateEntryResults log={workbench.active} actions={workbench.actions} />
          ) : (
            <div className="grid min-h-64 place-items-center rounded-xl border border-dashed xl:min-h-[calc(100%_-_4rem)]">
              <ListEmpty className="py-8" text={t("No images generated yet")} />
            </div>
          )}
        </section>
      </div>
      <GenerationWorkspaceSheet
        title={t("Image generation history")}
        open={showHistory}
        onOpenChange={setShowHistory}
        height="min(736px, 90dvh)"
      >
        <div className="min-h-0 overflow-y-auto p-4">{history}</div>
      </GenerationWorkspaceSheet>
      <DeleteGenerationDialog
        open={Boolean(workbench.deletion)}
        count={workbench.deletion?.ids.length ?? 0}
        busy={workbench.deleting}
        trigger={workbench.deleteTrigger}
        onClose={workbench.closeDeletion}
        onConfirm={() => {
          void workbench.deleteSelected();
        }}
      />
      {workbench.deleteError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {workbench.deleteError}
        </p>
      )}
      <PromptSelectDialog
        open={showPrompts}
        onOpenChange={setShowPrompts}
        onSelect={workbench.setPrompt}
      />
      <AssetPickerModal
        open={showAssets}
        parentSignal={workbench.pageSignal}
        onInsert={workbench.insertAsset}
        onClose={() => setShowAssets(false)}
      />
      {workbench.preview.preview && (
        <ImagePreviewGroup
          items={workbench.preview.preview.items}
          current={workbench.preview.preview.index}
          open
          onChange={workbench.preview.preview.select}
          onOpenChange={(open) => {
            if (!open) workbench.preview.close();
          }}
        />
      )}
    </main>
  );
}
