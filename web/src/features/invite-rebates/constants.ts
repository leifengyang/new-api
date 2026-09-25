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
// ============================================================================
// Ledger status
// ============================================================================

export const INVITE_REBATE_STATUS = {
  CREDITED: 'credited',
  SKIPPED: 'skipped',
} as const

export type InviteRebateStatus =
  (typeof INVITE_REBATE_STATUS)[keyof typeof INVITE_REBATE_STATUS]

export const INVITE_REBATE_STATUSES = {
  [INVITE_REBATE_STATUS.CREDITED]: {
    labelKey: 'Credited',
    variant: 'success' as const,
  },
  [INVITE_REBATE_STATUS.SKIPPED]: {
    labelKey: 'Not Credited',
    variant: 'warning' as const,
  },
} satisfies Record<InviteRebateStatus, { labelKey: string; variant: string }>

export const getInviteRebateStatusOptions = (t: (key: string) => string) =>
  Object.values(INVITE_REBATE_STATUS).map((status) => ({
    label: t(INVITE_REBATE_STATUSES[status].labelKey),
    value: status,
  }))

/**
 * Why nothing was credited. Only the reasons this backend can currently write
 * are listed; anything else falls back to the raw value so a new one still
 * shows up instead of rendering blank.
 */
export const SKIP_REASON_LABELS: Record<string, string> = {
  inviter_wallet_limit:
    'The inviter already holds the maximum balance, so this rebate could not be credited',
}

export const getSkipReasonLabel = (
  skipReason: string,
  t: (key: string) => string
): string => {
  const label = SKIP_REASON_LABELS[skipReason]
  return label ? t(label) : skipReason
}

// ============================================================================
// Top-up source
// ============================================================================

/**
 * Mirrors `model.InviteRebateSource*` — the entry point that took the payment.
 * The lookup falls back to the raw value so a new backend source still renders.
 */
export const INVITE_REBATE_SOURCE_LABELS: Record<string, string> = {
  epay: 'Epay',
  stripe: 'Stripe',
  creem: 'Creem',
  waffo: 'Waffo',
  waffo_pancake: 'Waffo Pancake',
  redemption: 'Redemption Code',
  manual: 'Manual Adjustment',
}

export const getInviteRebateSourceLabel = (
  source: string,
  t: (key: string) => string
): string => t(INVITE_REBATE_SOURCE_LABELS[source] ?? source)

export const getInviteRebateSourceOptions = (t: (key: string) => string) =>
  Object.entries(INVITE_REBATE_SOURCE_LABELS).map(([value, labelKey]) => ({
    label: t(labelKey),
    value,
  }))

// ============================================================================
// Reversal
// ============================================================================

/** Matches `maxReverseReasonLength` in controller/invite_rebate.go. */
export const REVERSE_REASON_MAX_LENGTH = 255
