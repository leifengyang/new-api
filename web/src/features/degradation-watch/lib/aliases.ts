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
export const DEGRADATION_WATCH_ALIAS_KEY =
  'degradation_watch_setting.channel_aliases'

export function parseAliases(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    }
  } catch {
    // An unset option comes back empty; treat it as no aliases.
  }
  return {}
}

/** Drops blank aliases so "clear the field" really takes a channel off the wall. */
export function serializeAliases(aliases: Record<string, string>): string {
  const cleaned: Record<string, string> = {}
  for (const [id, alias] of Object.entries(aliases)) {
    const trimmed = alias.trim()
    if (trimmed !== '') cleaned[id] = trimmed
  }
  return JSON.stringify(cleaned)
}
