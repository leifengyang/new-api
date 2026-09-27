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

import {
  DISABLED_ROW_DESKTOP,
  DISABLED_ROW_MOBILE,
  DataTablePage,
  useDataTable,
} from '@/components/data-table'
import { useMediaQuery } from '@/hooks'
import { useTableUrlState } from '@/hooks/use-table-url-state'
import { createServerError } from '@/lib/server-error-message'

import { getEnterpriseMembers } from '../api'
import {
  ENTERPRISE_MEMBER_STATUS,
  getEnterpriseMemberStatusOptions,
} from '../constants'
import { useEnterpriseMembersColumns } from './enterprise-members-columns'
import { useEnterprise } from './enterprise-provider'

const route = getRouteApi('/_authenticated/enterprise/')

export function EnterpriseMembersTable() {
  const { t } = useTranslation()
  const columns = useEnterpriseMembersColumns()
  const { refreshTrigger } = useEnterprise()
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
    columnFilters: [{ columnId: 'status', searchKey: 'status', type: 'array' }],
  })

  const statusFilter =
    (columnFilters.find((filter) => filter.id === 'status')?.value as
      | string[]
      | undefined) ?? []

  // 服务端按归属收窄到本企业的成员，关键字也只在这批人里匹配（用户名 / 显示名）。
  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      'enterprise',
      'members',
      pagination.pageIndex + 1,
      pagination.pageSize,
      globalFilter,
      statusFilter,
      refreshTrigger,
    ],
    queryFn: async () => {
      const result = await getEnterpriseMembers({
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
        keyword: globalFilter,
        status: statusFilter[0] ?? '',
      })
      if (!result.success) {
        throw createServerError(result, t('Failed to load members'))
      }
      return {
        items: result.data?.items ?? [],
        total: result.data?.total ?? 0,
      }
    },
    placeholderData: (previousData) => previousData,
  })

  const members = data?.items ?? []

  const { table } = useDataTable({
    data: members,
    columns,
    getRowId: (row) => String(row.id),
    columnFilters,
    globalFilter,
    pagination,
    onPaginationChange,
    onGlobalFilterChange,
    onColumnFiltersChange,
    manualPagination: true,
    manualFiltering: true,
    totalCount: data?.total ?? 0,
    ensurePageInRange,
  })

  return (
    <DataTablePage
      table={table}
      columns={columns}
      isLoading={isLoading}
      isFetching={isFetching}
      emptyTitle={t('No Members')}
      emptyDescription={t(
        'No members yet. Add one, or send an invite link and let them sign up themselves.'
      )}
      skeletonKeyPrefix='enterprise-members-skeleton'
      applyHeaderSize
      toolbarProps={{
        searchPlaceholder: t('Filter by username or display name...'),
        searchDebounceMs: 500,
        filters: [
          {
            columnId: 'status',
            title: t('Status'),
            options: getEnterpriseMemberStatusOptions(t),
            singleSelect: true,
          },
        ],
      }}
      getRowClassName={(row, { isMobile: mobile }) => {
        if (row.original.status !== ENTERPRISE_MEMBER_STATUS.DISABLED) {
          return undefined
        }
        return mobile ? DISABLED_ROW_MOBILE : DISABLED_ROW_DESKTOP
      }}
    />
  )
}
