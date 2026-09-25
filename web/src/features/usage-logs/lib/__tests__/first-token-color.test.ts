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
import { describe, expect, test } from 'vitest'

import { getFirstResponseTimeColor } from '../format'

describe('first token latency colour', () => {
  // 站点口径：10 秒内算快，30 秒内需要留意，再慢（含 60 秒以上）都是红色。
  test.each([
    { seconds: 0, expected: 'success' },
    { seconds: 9.9, expected: 'success' },
    { seconds: 10, expected: 'warning' },
    { seconds: 29.9, expected: 'warning' },
    { seconds: 30, expected: 'danger' },
    { seconds: 60, expected: 'danger' },
    { seconds: 600, expected: 'danger' },
  ])('maps $seconds s to $expected', ({ seconds, expected }) => {
    expect(getFirstResponseTimeColor(seconds)).toBe(expected)
  })
})
