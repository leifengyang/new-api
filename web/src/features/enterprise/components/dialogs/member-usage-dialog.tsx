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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { formatCompactNumber, formatPercent, formatQuota } from '@/lib/format'
import { createServerError } from '@/lib/server-error-message'

import { getEnterpriseUsage } from '../../api'
import { ERROR_MESSAGES } from '../../constants'
import { sumUsageQuota } from '../../lib/usage'
import type { EnterpriseUsageRange, EnterpriseUsageRow } from '../../types'

interface MemberUsageDialogProps {
  member: EnterpriseUsageRow | null
  range: EnterpriseUsageRange
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 单个成员的按模型用量。范围跟着页面的时间窗走，口径也收窄到这一个成员
 * （此时不含企业账号自己 —— 服务端按 member_id 下钻时就是这么定的）。
 */
export function MemberUsageDialog(props: MemberUsageDialogProps) {
  const { t } = useTranslation()
  const memberId = props.member?.user_id ?? 0
  const enabled = props.open && memberId > 0

  const usageQuery = useQuery({
    queryKey: [
      'enterprise',
      'usage',
      'member',
      memberId,
      props.range.start,
      props.range.end,
    ],
    enabled,
    queryFn: async () => {
      const result = await getEnterpriseUsage(props.range, memberId)
      if (!result.success) {
        throw createServerError(result, t(ERROR_MESSAGES.LOAD_USAGE_FAILED))
      }
      return {
        // 没有成员时服务端不给数据，nil 已经归一成空数组。
        byModel: result.data?.by_model ?? [],
        dataExportEnabled: result.data?.data_export_enabled ?? true,
      }
    },
  })

  const byModel = usageQuery.data?.byModel ?? []
  const total = sumUsageQuota(byModel)

  let body: ReactNode
  if (usageQuery.isError) {
    body = (
      <ErrorState
        description={usageQuery.error.message}
        onRetry={() => void usageQuery.refetch()}
      />
    )
  } else if (usageQuery.isLoading) {
    body = <LoadingState />
  } else if (usageQuery.data?.dataExportEnabled === false) {
    // 平台的用量看板关掉时 quota_data 不落库，这时候的空表是「没有数据」，
    // 不是「这个人没花过钱」，必须说清楚。
    body = (
      <p className='text-muted-foreground text-sm'>
        {t(
          'Usage statistics are turned off on this platform, so there is no per-model breakdown.'
        )}
      </p>
    )
  } else {
    body = (
      <>
        <div className='text-muted-foreground text-sm'>
          {t('Total Usage')}:{' '}
          <span className='text-foreground font-mono tabular-nums'>
            {formatQuota(total)}
          </span>
        </div>
        <StaticDataTable
          data={byModel}
          getRowKey={(row) => row.model_name}
          empty
          emptyContent={
            <span className='text-muted-foreground text-sm'>
              {t('No usage in this period')}
            </span>
          }
          columns={[
            {
              id: 'model_name',
              header: t('Model'),
              cell: (row) => row.model_name || '-',
            },
            {
              id: 'count',
              header: t('Requests'),
              className: 'text-right',
              cell: (row) => (
                <span className='font-mono text-sm tabular-nums'>
                  {formatCompactNumber(row.count)}
                </span>
              ),
            },
            {
              id: 'quota',
              header: t('Total Usage'),
              className: 'text-right',
              cell: (row) => (
                <span className='font-mono text-sm tabular-nums'>
                  {formatQuota(row.quota)}
                </span>
              ),
            },
            {
              id: 'share',
              header: t('Share'),
              className: 'text-right',
              cell: (row) => (
                <span className='font-mono text-sm tabular-nums'>
                  {formatPercent(total > 0 ? (row.quota / total) * 100 : 0)}
                </span>
              ),
            },
          ]}
        />
      </>
    )
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Usage by Model for {{username}}', {
        username: props.member?.username ?? '',
      })}
      contentClassName='sm:max-w-2xl'
      bodyClassName='space-y-3'
    >
      {body}
    </Dialog>
  )
}
