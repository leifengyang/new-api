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
import {
  LOG_TYPE_ALL_VALUE,
  LOG_TYPE_FILTERS,
} from '@/features/usage-logs/constants'
import { useMediaQuery } from '@/hooks'
import { useTableUrlState } from '@/hooks/use-table-url-state'
import { formatQuota } from '@/lib/format'
import { createServerError } from '@/lib/server-error-message'

import { getEnterpriseLogs } from '../api'
import { ERROR_MESSAGES } from '../constants'
import type { EnterpriseUsageRange } from '../types'
import { useEnterpriseLogsColumns } from './enterprise-logs-columns'

const route = getRouteApi('/_authenticated/enterprise/logs')

interface EnterpriseLogsTableProps {
  range: EnterpriseUsageRange
}

export function EnterpriseLogsTable(props: EnterpriseLogsTableProps) {
  const { t } = useTranslation()
  const columns = useEnterpriseLogsColumns()
  const isMobile = useMediaQuery('(max-width: 640px)')

  const {
    columnFilters,
    onColumnFiltersChange,
    pagination,
    onPaginationChange,
    ensurePageInRange,
  } = useTableUrlState({
    search: route.useSearch(),
    navigate: route.useNavigate(),
    pagination: { defaultPage: 1, defaultPageSize: isMobile ? 20 : 50 },
    globalFilter: { enabled: false },
    columnFilters: [
      { columnId: 'created_at', searchKey: 'type', type: 'array' },
    ],
  })

  // 「全部类型」在接口里就是不带 type 参数（服务端把 0 当不筛选）。
  const selectedType =
    (columnFilters.find((filter) => filter.id === 'created_at')?.value as
      | string[]
      | undefined) ?? []
  const type = selectedType.find((value) => value !== LOG_TYPE_ALL_VALUE) ?? ''

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      'enterprise',
      'logs',
      props.range.start,
      props.range.end,
      type,
      pagination.pageIndex + 1,
      pagination.pageSize,
    ],
    queryFn: async () => {
      const result = await getEnterpriseLogs({
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
        type,
        start_timestamp: props.range.start,
        end_timestamp: props.range.end,
      })
      if (!result.success) {
        throw createServerError(result, t(ERROR_MESSAGES.LOAD_LOGS_FAILED))
      }
      return {
        items: result.data?.items ?? [],
        total: result.data?.total ?? 0,
        quotaTotal: result.data?.quota_total ?? 0,
      }
    },
    placeholderData: (previousData) => previousData,
  })

  const logs = data?.items ?? []

  const { table } = useDataTable({
    data: logs,
    columns,
    getRowId: (row) => String(row.id),
    columnFilters,
    pagination,
    onPaginationChange,
    onColumnFiltersChange,
    manualPagination: true,
    manualFiltering: true,
    totalCount: data?.total ?? 0,
    enableRowSelection: false,
    ensurePageInRange,
  })

  return (
    <div className='space-y-3'>
      {/* 合计是整段筛选的总花费，不是当前这一页；分页翻页时它不会变。 */}
      <p className='text-muted-foreground text-sm'>
        {t('Total cost of the selected logs')}:{' '}
        <span className='text-foreground font-mono tabular-nums'>
          {formatQuota(data?.quotaTotal ?? 0)}
        </span>
      </p>
      <DataTablePage
        table={table}
        columns={columns}
        isLoading={isLoading}
        isFetching={isFetching}
        emptyTitle={t('No Logs')}
        emptyDescription={t(
          'No member activity matches the current filters in this period.'
        )}
        skeletonKeyPrefix='enterprise-logs-skeleton'
        applyHeaderSize
        toolbarProps={{
          filters: [
            {
              columnId: 'created_at',
              title: t('Type'),
              options: LOG_TYPE_FILTERS.map((option) => ({
                label: t(option.label),
                value: option.value,
              })),
              singleSelect: true,
            },
          ],
        }}
      />
    </div>
  )
}
