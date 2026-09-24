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
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { createServerError } from '@/lib/server-error-message'

import { getSelfInviteRebates } from '../api'

export const SELF_REBATES_PAGE_SIZE = 20

interface SelfInviteRebatesOptions {
  page?: number
  pageSize?: number
  /** The details dialog only loads this once it is opened. */
  enabled?: boolean
}

/**
 * The signed-in member's own rebates. The endpoint always answers with the
 * cumulative summary alongside the requested page, so the wallet card and its
 * details dialog can share one query family.
 */
export function useSelfInviteRebates({
  page = 1,
  pageSize = SELF_REBATES_PAGE_SIZE,
  enabled = true,
}: SelfInviteRebatesOptions = {}) {
  const { t } = useTranslation()

  return useQuery({
    queryKey: ['invite-rebates', 'self', page, pageSize],
    enabled,
    queryFn: async () => {
      const result = await getSelfInviteRebates({
        p: page,
        page_size: pageSize,
      })

      if (!result.success || !result.data) {
        throw createServerError(result, t('Failed to load your rebates'))
      }

      return result.data
    },
  })
}
