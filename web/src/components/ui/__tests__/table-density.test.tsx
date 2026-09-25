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
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test } from 'vitest'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../table'

function renderTable(cellContent: ReactNode = 'value') {
  render(
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>{cellContent}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

describe('table density', () => {
  // 后台表格按紧凑密度交付：行高 44px 起、表头 36px、单元格收窄内边距。
  test('renders rows and cells on the compact density contract', () => {
    renderTable()

    const body = screen.getByRole('row', { name: 'value' }).parentElement
    expect(body).toHaveClass('[&>tr]:h-11')
    expect(screen.getByRole('columnheader')).toHaveClass('h-9')
    expect(screen.getByRole('cell')).toHaveClass('px-2', 'py-1.5')
  })

  test('keeps every cell on the 13px body size and spares only the marked secondary text', () => {
    renderTable(
      <span data-table-text='secondary' data-testid='secondary'>
        2026-09-25
      </span>
    )

    const table = screen.getByRole('table')
    expect(table).toHaveClass('[&_td]:text-[13px]', '[&_th]:text-[13px]')
    // 单元格内自定义字号必须被表体字号接管，否则列宽会随内容跳动。
    expect(table).toHaveClass('[&_:is(th,td)_*]:[font-size:inherit]')
    expect(table).toHaveClass('[&_[data-table-text=secondary]]:text-xs')
    expect(screen.getByTestId('secondary')).toHaveAttribute(
      'data-table-text',
      'secondary'
    )
  })
})
