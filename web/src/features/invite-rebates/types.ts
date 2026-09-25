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
import { z } from 'zod'

// ============================================================================
// Invite Rebate Schema & Types
// ============================================================================

/**
 * One row of the invite rebate ledger. `inviter_name` / `invitee_name` are
 * resolved by the backend; the student-facing endpoint masks the downline name
 * instead of hiding the row.
 */
export const inviteRebateSchema = z.object({
  id: z.number(),
  inviter_id: z.number(),
  inviter_name: z.string(),
  invitee_id: z.number(),
  invitee_name: z.string(),
  source: z.string(),
  source_ref: z.string(),
  base_quota: z.number(),
  rate_basis_points: z.number(),
  rebate_quota: z.number(),
  /** Rebate left after any reversal; 0 once the whole credit was clawed back. */
  outstanding_quota: z.number(),
  status: z.string(),
  /** Why nothing was credited; empty unless `status` is `skipped`. */
  skip_reason: z.string(),
  reversed_quota: z.number(),
  reversed_at: z.number(),
  reversed_by: z.number(),
  reverse_reason: z.string(),
  created_at: z.number(),
})

export type InviteRebate = z.infer<typeof inviteRebateSchema>

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

export interface GetInviteRebatesParams {
  p?: number
  page_size?: number
  keyword?: string
  source?: string
  status?: string
}

export interface GetInviteRebatesResponse {
  success: boolean
  message?: string
  data?: {
    items: InviteRebate[]
    total: number
    page: number
    page_size: number
  }
}

/** Cumulative rebates for one inviter, returned by the self endpoint. */
export interface InviteRebateSummary {
  total_quota: number
  reversed_quota: number
  rebate_count: number
}

/**
 * The member's own view of their rebates. The downline name is masked and the
 * money the member does not need to know about — who reversed a rebate and why
 * — stays on the administrator's copy of the row.
 */
export interface SelfInviteRebatesData {
  page: {
    items: InviteRebate[]
    total: number
    page: number
    page_size: number
  }
  summary: InviteRebateSummary
  rate_basis_points: number
  /** Whether the administrator has the rebate programme switched on. */
  rebate_enabled: boolean
  member_level: number
  /**
   * Whether this member takes part in the programme at all. Only
   * administrators are excluded; an external user still earns a rebate, just
   * only on each invitee's first top-up.
   */
  rebate_available: boolean
}

export interface GetSelfInviteRebatesResponse {
  success: boolean
  message?: string
  data?: SelfInviteRebatesData
}
