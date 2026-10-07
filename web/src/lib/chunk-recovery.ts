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
const RELOAD_KEY = 'newapi:chunk-recovery:v1'
const RELOAD_COOLDOWN = 10 * 60 * 1000

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === 'ChunkLoadError' ||
    /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      error.message
    )
  )
}

// A single tab may reload at most once in ten minutes, across builds and
// repeated React effects. If storage is unavailable, offer manual recovery.
export function recoverChunkLoadError(
  error: unknown,
  reload: () => void
): boolean {
  if (!isChunkLoadError(error) || !navigator.onLine) return false
  try {
    const previous = Number(sessionStorage.getItem(RELOAD_KEY))
    const now = Date.now()
    if (previous > 0 && now - previous < RELOAD_COOLDOWN) return false
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    return false
  }
  reload()
  return true
}
