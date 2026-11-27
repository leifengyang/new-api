// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Clipboard, Upload, X } from "lucide-react";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { ImageThumbnail } from "@workbench/components/image-thumbnail";
import type { ReferenceImage } from "@workbench/types/image";

type Props = {
  images: ReferenceImage[];
  busy: boolean;
  disabled: boolean;
  onFiles: (files: File[]) => Promise<void>;
  onPaste: () => Promise<void>;
  onRemove: (id: string) => void;
  onPreview: (image: ReferenceImage) => void;
};

export function ImageWorkbenchReferences(props: Props) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  return (
    <section
      aria-labelledby="image-workbench-references"
      aria-busy={props.busy}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="image-workbench-references" className="text-base font-semibold">
          {t("Reference images")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.disabled || props.busy}
            onClick={() => {
              void props.onPaste();
            }}
          >
            <Clipboard aria-hidden className="size-4" />
            {t("Paste")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.disabled || props.busy}
            onClick={() => input.current?.click()}
          >
            <Upload aria-hidden className="size-4" />
            {t("Upload")}
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label={t("Upload reference images")}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            if (!props.disabled && files.length) void props.onFiles(files);
          }}
        />
      </div>
      <div
        className="min-h-32 rounded-xl border border-dashed p-3"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!props.disabled) void props.onFiles([...event.dataTransfer.files]);
        }}
      >
        {props.images.length ? (
          <div className="flex flex-wrap gap-3">
            {props.images.map((image) => (
              <div key={image.id} className="relative w-20">
                <Button
                  type="button"
                  variant="ghost"
                  className="!h-20 !w-20 overflow-hidden rounded-lg !p-0"
                  aria-label={t("Preview reference image {{name}}", { name: image.name })}
                  onClick={() => props.onPreview(image)}
                >
                  {image.storageKey ? (
                    <ImageThumbnail
                      storageKey={image.storageKey}
                      alt={image.name}
                      className="size-full"
                    />
                  ) : (
                    <img
                      src={image.url || image.dataUrl}
                      alt={image.name}
                      className="size-full object-cover"
                    />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -right-1 -top-1 rounded-full"
                  disabled={props.disabled}
                  aria-label={t("Remove reference image {{name}}", { name: image.name })}
                  onClick={() => props.onRemove(image.id)}
                >
                  <X aria-hidden className="size-3" />
                </Button>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={image.name}>
                  {image.name}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="flex min-h-24 items-center justify-center text-center text-sm text-muted-foreground">
            {t("Drop reference images here, or upload and paste them.")}
          </p>
        )}
      </div>
      {props.busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Saving reference images…")}
        </p>
      )}
    </section>
  );
}
