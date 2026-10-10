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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import { compensationPath } from './api'

export type ReportFilter = Record<string, string | number | boolean>
export type Aggregate = {
  d0: string
  d1: string
  d2: string
  l0: string
  l1: string
  l2: string
  quota: number
  count: number
  users: number
}
export type ReportOverview = {
  quota: number
  count: number
  users: number
  trend: Aggregate[]
  rankings: Record<string, Aggregate[]>
}
export const dimensionLabels: Record<string, string> = {
  user: 'User',
  channel: 'Channel',
  group: 'Group',
  model: 'Model',
  day: 'Date',
  reason: 'Reason',
  funding: 'Original funding source',
}
export const fundingLabels: Record<string, string> = {
  personal: 'Personal',
  enterprise: 'Enterprise',
  subscription: 'Subscription',
  mixed: 'Enterprise + personal',
  '': 'Unknown',
}

export function beijingTime(seconds: number) {
  return new Date((seconds + 8 * 3600) * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)
}
export function initialReportFilter(): ReportFilter {
  const today = beijingTime(Date.now() / 1000).slice(0, 10)
  const end = Date.parse(`${today}T00:00:00+08:00`) / 1000 + 86400
  return { time_basis: 'credited', start_at: end - 30 * 86400, end_at: end }
}
export function drillFilter(
  filter: ReportFilter,
  dimensions: string[],
  row: Aggregate
): ReportFilter {
  const values = [row.d0, row.d1, row.d2]
  return {
    ...filter,
    ...Object.fromEntries(dimensions.map((d, i) => [d, values[i]])),
  }
}
export async function exportReport(
  filter: ReportFilter,
  dimensions: string[],
  kind: 'aggregate' | 'records'
) {
  const response = await api.get(`${compensationPath}/admin/export`, {
    params: { ...filter, dimensions: dimensions.join(','), kind },
    responseType: 'blob',
  })
  const blob = response.data as Blob
  if (!String(response.headers['content-type']).includes('text/csv')) {
    requireServerSuccess(JSON.parse(await blob.text()))
    throw new Error('Invalid CSV response')
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `compensation-${kind}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function aggregateLabel(
  dimension: string,
  value: string,
  label: string,
  unknown: string
) {
  if (dimension === 'channel' && value === '0') return unknown
  if (!value) return unknown
  if (label) return `${label} · #${value}`
  return value
}
