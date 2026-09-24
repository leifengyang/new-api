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
import { expect, test } from 'vitest'

import {
  basisPointsToPercent,
  formatInviteRebatePercent,
  percentToBasisPoints,
} from '../invite-rebate-rate'

test.each([
  [1000, 10],
  [1250, 12.5],
  [1, 0.01],
  [0, 0],
  [10000, 100],
])('reads %i basis points as %s percent', (basisPoints, percent) => {
  expect(basisPointsToPercent(basisPoints)).toBe(percent)
})

test.each([
  [10, 1000],
  [12.5, 1250],
  [0.01, 1],
  [0, 0],
  [100, 10000],
])('stores %s percent as %i basis points', (percent, basisPoints) => {
  expect(percentToBasisPoints(percent)).toBe(basisPoints)
})

// Integer basis points and two-decimal percents are the same set of rates, so
// opening the form and saving it unchanged must never shift the stored value.
test.each([
  [0, 0],
  [1, 0.01],
  [1000, 10],
  [1250, 12.5],
  [10000, 100],
])(
  'the rate %i basis points / %s percent survives a form round trip',
  (basisPoints, percent) => {
    expect(percentToBasisPoints(basisPointsToPercent(basisPoints))).toBe(
      basisPoints
    )
    expect(basisPointsToPercent(percentToBasisPoints(percent))).toBe(percent)
  }
)

// The numeric input can be cleared mid-edit, and a non-finite value must not
// reach the form as NaN: that is what silently freezes the save button.
test('non-finite input degrades to a zero rate', () => {
  expect(basisPointsToPercent(Number.NaN)).toBe(0)
  expect(percentToBasisPoints(Number.NaN)).toBe(0)
  expect(percentToBasisPoints(Number.POSITIVE_INFINITY)).toBe(0)
})

test.each([
  [1000, '10%'],
  [1250, '12.5%'],
  [1, '0.01%'],
  [0, '0%'],
])('formats %i basis points as %s', (basisPoints, expected) => {
  expect(formatInviteRebatePercent(basisPoints)).toBe(expected)
})
