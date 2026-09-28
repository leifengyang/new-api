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
import type { DegradationWatchRecord } from '../types'

export const WALL_PAGE_SIZE = 12

/**
 * Merges the wall's first page with pages loaded through "Load more". The
 * wall refetches on an interval, so newer records can arrive at the top while
 * older pages are already loaded; ids keep the union free of duplicates.
 */
export function mergeRecords(
  head: DegradationWatchRecord[],
  tail: DegradationWatchRecord[]
): DegradationWatchRecord[] {
  const seen = new Set(head.map((record) => record.id))
  return [...head, ...tail.filter((record) => !seen.has(record.id))]
}
