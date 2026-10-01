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
import type { LogOtherData } from '../types'

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

/** Normalize display counters independently of pricing variables. */
export function getLogTokenUsage(
  prompt: number,
  completion: number,
  other: LogOtherData | null
) {
  const cacheRead = count(other?.cache_tokens)
  const write5m = count(other?.cache_creation_tokens_5m) ?? 0
  const write1h = count(other?.cache_creation_tokens_1h) ?? 0
  const cacheWrite =
    count(other?.cache_write_tokens) ??
    Math.max(count(other?.cache_creation_tokens) ?? 0, write5m + write1h)
  const rawInput = count(prompt) ?? 0
  const output = count(completion) ?? 0
  const separateCache =
    other?.usage_semantic === 'anthropic' ||
    (other?.usage_semantic == null && other?.claude === true)
  const totalInput =
    count(other?.input_tokens_total) ??
    (separateCache ? rawInput + (cacheRead ?? 0) + cacheWrite : rawInput)
  return {
    input: Math.max(0, totalInput - (cacheRead ?? 0) - cacheWrite),
    output,
    totalInput,
    total: totalInput + output,
    cacheRead,
    cacheWrite,
    write5m,
    write1h,
    hitRate:
      cacheRead !== null && totalInput > 0 && cacheRead <= totalInput
        ? (cacheRead / totalInput) * 100
        : null,
  }
}
