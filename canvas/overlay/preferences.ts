// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { storage } from "@workbench/services/storage/runtime";

// Used by the overlay's config-store patch. Credentials remain excluded by upstream partialize().
export const canvasPreferences = {
  getItem: (key: string) => storage.preferences.getItem<string>(`config:${key}`),
  setItem: async (key: string, value: string) => { await storage.preferences.setItem(`config:${key}`, value); },
  removeItem: (key: string) => storage.preferences.removeItem(`config:${key}`),
};
