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
import { getRouteApi } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { DataTablePage, useDataTable } from '@/components/data-table'
import { useMediaQuery } from '@/hooks'
import { useTableUrlState } from '@/hooks/use-table-url-state'
import { createServerError } from '@/lib/server-error-message'

import { getInviteRebates } from '../api'
import {
  getInviteRebateSourceOptions,
  getInviteRebateStatusOptions,
} from '../constants'
import { useInviteRebatesColumns } from './invite-rebates-columns'
import { useInviteRebates } from './invite-rebates-provider'

const route = getRouteApi('/_authenticated/invite-rebates/')

export function InviteRebatesTable() {
  const { t } = useTranslation()
  const columns = useInviteRebatesColumns()
  const { refreshTrigger } = useInviteRebates()
  const isMobile = useMediaQuery('(max-width: 640px)')

  const {
    globalFilter,
    onGlobalFilterChange,
    columnFilters,
    onColumnFiltersChange,
    pagination,
    onPaginationChange,
    ensurePageInRange,
  } = useTableUrlState({
    search: route.useSearch(),
    navigate: route.useNavigate(),
    pagination: { defaultPage: 1, defaultPageSize: isMobile ? 10 : 20 },
    globalFilter: { enabled: true, key: 'filter' },
    columnFilters: [
      { columnId: 'source', searchKey: 'source', type: 'array' },
      { columnId: 'status', searchKey: 'status', type: 'array' },
    ],
  })
  const sourceFilter =
    (columnFilters.find((filter) => filter.id === 'source')?.value as
      | string[]
      | undefined) ?? []
  const statusFilter =
    (columnFilters.find((filter) => filter.id === 'status')?.value as
      | string[]
      | undefined) ?? []

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      'invite-rebates',
      pagination.pageIndex + 1,
      pagination.pageSize,
      globalFilter,
      sourceFilter,
      statusFilter,
      refreshTrigger,
    ],
    queryFn: async () => {
      const result = await getInviteRebates({
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
        keyword: globalFilter,
        source: sourceFilter[0] ?? '',
        status: statusFilter[0] ?? '',
      })

      if (!result.success) {
        throw createServerError(result, t('Failed to load invite rebates'))
      }

      return {
        items: result.data?.items || [],
        total: result.data?.total || 0,
      }
    },
    placeholderData: (previousData) => previousData,
  })

  const { table } = useDataTable({
    data: data?.items || [],
    columns,
    columnFilters,
    globalFilter,
    pagination,
    globalFilterFn: (row, _columnId, filterValue) => {
      const searchValue = String(filterValue).toLowerCase()
      return [
        row.original.inviter_name,
        row.original.invitee_name,
        row.original.source_ref,
      ].some((field) =>
        String(field || '')
          .toLowerCase()
          .includes(searchValue)
      )
    },
    onPaginationChange,
    onGlobalFilterChange,
    onColumnFiltersChange,
    manualPagination: true,
    manualFiltering: true,
    totalCount: data?.total || 0,
    ensurePageInRange,
  })

  return (
    <DataTablePage
      table={table}
      columns={columns}
      isLoading={isLoading}
      isFetching={isFetching}
      emptyTitle={t('No Invite Rebates Found')}
      emptyDescription={t(
        'No invite rebates yet. Rebates appear here once an internal member they invited tops up.'
      )}
      skeletonKeyPrefix='invite-rebates-skeleton'
      applyHeaderSize
      toolbarProps={{
        searchPlaceholder: t('Filter by inviter or invitee...'),
        searchDebounceMs: 500,
        filters: [
          {
            columnId: 'source',
            title: t('Source'),
            options: getInviteRebateSourceOptions(t),
            singleSelect: true,
          },
          {
            columnId: 'status',
            title: t('Status'),
            options: getInviteRebateStatusOptions(t),
            singleSelect: true,
          },
        ],
      }}
    />
  )
}
