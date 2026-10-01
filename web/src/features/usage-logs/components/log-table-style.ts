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
export const logTableClassName =
  '[--table-header:var(--background)] [&_thead_th]:h-8 [&_thead_th]:text-muted-foreground [&_thead_th]:font-normal [&_thead_tr]:hover:bg-transparent [&_tbody_td]:py-1 [&_tbody_td]:font-normal [&_tbody_td]:leading-tight [&_tbody_tr]:h-11 [&_[data-slot=avatar]]:size-5 [&_[data-table-text=secondary]]:!text-[11px] [&_[data-table-text=secondary]_*]:!text-[11px] [&_[data-table-text=secondary]]:!font-normal'

// Reserve stronger color for cache hits and exceptional states. Metadata stays quiet.
export const logBadgeClassName =
  'h-5 gap-1 rounded-md border px-1.5 py-0 font-normal'
export const logBadgeTone = {
  neutral: 'border-border/60 bg-muted/40 !text-foreground/80',
  model:
    'border-indigo-500/15 bg-indigo-500/6 !text-indigo-800 dark:!text-indigo-200',
  cost: 'border-emerald-500/15 bg-emerald-500/8 !text-emerald-800 dark:!text-emerald-200',
  stream: 'border-sky-500/15 bg-sky-500/8 !text-sky-800 dark:!text-sky-200',
}
export const logTypeBadgeClassName =
  'h-[18px] rounded-md border border-current/10 bg-current/5 px-1.5 py-0 !text-[11px] [&_span]:!text-[11px]'
