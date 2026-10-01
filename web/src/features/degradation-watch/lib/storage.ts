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
import type { SelfTestResult } from './self-test'

/**
 * Self-test results and the optional remembered key live only in this
 * browser. Storage can be unavailable (private mode, quota), so every access
 * degrades to "nothing remembered" instead of throwing.
 */
const HISTORY_KEY = 'degradation-watch:self-test-history'
const SETTINGS_KEY = 'degradation-watch:self-test-settings'

export const SELF_TEST_HISTORY_LIMIT = 12

export interface SelfTestSettings {
  baseUrl: string
  model: string
  reasoningEffort: string
  rememberKey: boolean
  /** Only stored when `rememberKey` is on. */
  apiKey: string
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota exceeded or storage disabled: the result is still shown this session.
  }
}

export function loadSelfTestHistory(): SelfTestResult[] {
  const stored = read<SelfTestResult[]>(HISTORY_KEY)
  return Array.isArray(stored) ? stored : []
}

/** Prepends `result` and keeps the newest SELF_TEST_HISTORY_LIMIT entries. */
export function saveSelfTestResult(result: SelfTestResult): SelfTestResult[] {
  const next = [result, ...loadSelfTestHistory()].slice(
    0,
    SELF_TEST_HISTORY_LIMIT
  )
  write(HISTORY_KEY, next)
  return next
}

export function removeSelfTestResult(id: string): SelfTestResult[] {
  const next = loadSelfTestHistory().filter((item) => item.id !== id)
  write(HISTORY_KEY, next)
  return next
}

export function loadSelfTestSettings(): Partial<SelfTestSettings> {
  return read<Partial<SelfTestSettings>>(SETTINGS_KEY) ?? {}
}

/** Upgrade old browser settings without retaining the previously plaintext key. */
export function migrateSelfTestSettings(): Partial<SelfTestSettings> {
  const stored = loadSelfTestSettings()
  const settings = { ...stored, apiKey: '', rememberKey: false }
  if (stored.apiKey || stored.rememberKey) write(SETTINGS_KEY, settings)
  return settings
}

export function saveSelfTestSettings(settings: SelfTestSettings) {
  write(SETTINGS_KEY, {
    ...settings,
    apiKey: settings.rememberKey ? settings.apiKey : '',
  })
}
