/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { z } from 'zod'

/** Mirrors MaxDegradationWatchTargets in degradation_watch_setting.go. */
export const MAX_DEGRADATION_WATCH_TARGETS = 20

export const targetSchema = z.object({
  model: z.string().trim().min(1),
  group: z.string().trim().min(1),
  reasoningEffort: z.string(),
  enabled: z.boolean(),
})

export type TargetValues = z.infer<typeof targetSchema>

export interface LegacyTarget {
  group: string
  model: string
  reasoningEffort: string
}

/**
 * Reads the stored `targets` JSON. An empty list means the server still runs
 * the legacy single target, so the editor starts from that one instead.
 */
export function parseTargets(raw: string, legacy: LegacyTarget): TargetValues[] {
  let parsed: unknown = []
  try {
    parsed = JSON.parse(raw || '[]')
  } catch {
    parsed = []
  }
  const targets: TargetValues[] = []
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      targets.push({
        model: typeof entry.model === 'string' ? entry.model : '',
        group: typeof entry.group === 'string' ? entry.group : '',
        reasoningEffort:
          typeof entry.reasoning_effort === 'string'
            ? entry.reasoning_effort
            : '',
        enabled: entry.enabled === true,
      })
    }
  }
  if (targets.length > 0 || legacy.model.trim() === '') return targets
  return [{ ...legacy, enabled: true }]
}

export function serializeTargets(targets: TargetValues[]): string {
  return JSON.stringify(
    targets.map((target) => ({
      model: target.model.trim(),
      group: target.group.trim(),
      reasoning_effort: target.reasoningEffort,
      enabled: target.enabled,
    }))
  )
}

/** Index of the first model that repeats an earlier one, or -1. */
export function findDuplicateTarget(targets: TargetValues[]): number {
  const seen = new Set<string>()
  for (const [index, target] of targets.entries()) {
    const model = target.model.trim()
    if (seen.has(model)) return index
    seen.add(model)
  }
  return -1
}
