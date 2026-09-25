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
// 与共享表格基元保持同一密度口径：13px 正文、py-2 单元格、py-1.5 表头。
export const staticDataTableClassNames = {
  container: 'overflow-hidden rounded-md border',
  sectionContainer: 'border-border/60 rounded-lg',
  embeddedContainer: 'rounded-none border-0',
  compactTable: 'text-[13px]',
  compactHeaderRow: 'hover:bg-transparent',
  mutedHeaderRow:
    '[background-color:var(--table-header)] hover:[background-color:var(--table-header-hover)]',
  compactHeaderCell:
    'text-muted-foreground py-1.5 text-[10px] font-medium tracking-wider uppercase',
  compactHeaderCellRight:
    'text-muted-foreground py-1.5 text-right text-[10px] font-medium tracking-wider uppercase',
  compactCell: 'py-2',
  compactTopCell: 'py-2 align-top',
  compactTopNumericCell: 'py-2 text-right align-top font-mono',
  compactMutedCell: 'text-muted-foreground py-2',
  compactMutedCodeCell: 'text-muted-foreground py-2 font-mono',
  compactNumericCell: 'py-2 text-right font-mono',
  compactMutedNumericCell: 'text-muted-foreground py-2 text-right font-mono',
  topCell: 'py-2 align-top',
  topMutedCell: 'text-muted-foreground py-2 align-top',
  codeCell: 'font-mono text-[13px]',
  mutedCell: 'text-muted-foreground text-[13px]',
  mutedCodeCell: 'text-muted-foreground font-mono text-[13px]',
  topNumericCell: 'py-2 text-right font-mono',
  mediumCell: 'font-medium',
  actionHeaderCell: 'w-auto max-w-none text-right',
  actionCell: 'w-auto max-w-none text-right',
} as const
