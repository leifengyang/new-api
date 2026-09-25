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
/**
 * The backend stores the invite rebate rate as integer basis points
 * (`invite_rebate_setting.rate_basis_points`, 1000 = 10%, 10000 = 100%) so the
 * payout math stays exact. Administrators think in percent, so the settings
 * form shows percent and converts at the boundary. Percent carries at most two
 * decimals, which is exactly one basis point, so the round trip is lossless.
 */
export const MAX_INVITE_REBATE_RATE_BASIS_POINTS = 10000

export function basisPointsToPercent(basisPoints: number): number {
  if (!Number.isFinite(basisPoints)) {
    return 0
  }
  return basisPoints / 100
}

export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0
  }
  return Math.round(percent * 100)
}

/** Renders a rate for display, trimming the trailing zeros of whole percents. */
export function formatInviteRebatePercent(basisPoints: number): string {
  const percent = basisPointsToPercent(basisPoints)
  return `${Number.parseFloat(percent.toFixed(2))}%`
}
