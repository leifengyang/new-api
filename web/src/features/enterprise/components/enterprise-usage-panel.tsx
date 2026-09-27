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
import { Info } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { CompactDateTimeRangePicker } from '@/features/usage-logs/components/compact-date-time-range-picker'
import { createServerError } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getEnterpriseUsage } from '../api'
import { ERROR_MESSAGES } from '../constants'
import { useEnterpriseRange } from '../hooks/use-enterprise-range'
import {
  buildUsageShares,
  foldTrendToLocalDays,
  limitUsageShares,
  sumUsageQuota,
} from '../lib/usage'
import { EnterpriseUsageCharts } from './enterprise-usage-charts'
import { EnterpriseUsageMemberTable } from './enterprise-usage-member-table'
import { EnterpriseUsageSummary } from './enterprise-usage-summary'

export function EnterpriseUsagePanel() {
  const { t } = useTranslation()
  const currentUserId = useAuthStore((state) => state.auth.user?.id)
  const { seconds, pickerRange, handleRangeChange } = useEnterpriseRange()

  const usageQuery = useQuery({
    queryKey: ['enterprise', 'usage', seconds.start, seconds.end],
    queryFn: async () => {
      const result = await getEnterpriseUsage(seconds)
      if (!result.success) {
        throw createServerError(result, t(ERROR_MESSAGES.LOAD_USAGE_FAILED))
      }
      return {
        dataExportEnabled: result.data?.data_export_enabled ?? true,
        byModel: result.data?.by_model ?? [],
        byMember: result.data?.by_member ?? [],
        trend: result.data?.trend ?? [],
      }
    },
    placeholderData: (previousData) => previousData,
  })

  const data = usageQuery.data
  const byMember = data?.byMember ?? []

  const totalQuota = sumUsageQuota(byMember)
  const totalCount = byMember.reduce((sum, row) => sum + row.count, 0)
  // 企业账号自己那一行也是「成员」，但它是本账号，不占成员名额。
  const memberCount = byMember.filter(
    (row) => row.user_id !== currentUserId
  ).length

  const modelShares = useMemo(
    () =>
      limitUsageShares(
        buildUsageShares(data?.byModel ?? [], (row) => row.model_name)
      ),
    [data?.byModel]
  )
  const trendPoints = useMemo(
    () => foldTrendToLocalDays(data?.trend ?? [], seconds),
    [data?.trend, seconds]
  )

  let content: ReactNode
  if (usageQuery.isError) {
    content = (
      <ErrorState
        description={usageQuery.error.message}
        onRetry={() => void usageQuery.refetch()}
      />
    )
  } else if (usageQuery.isLoading) {
    content = (
      <div className='space-y-4'>
        <Skeleton className='h-28 w-full' />
        <div className='grid gap-4 lg:grid-cols-2'>
          <Skeleton className='h-[380px] w-full' />
          <Skeleton className='h-[380px] w-full' />
        </div>
      </div>
    )
  } else if (data?.dataExportEnabled === false) {
    // 平台的用量看板关掉时 quota_data 根本不落库，这时候查出来必然是空的。
    // 显示一排 0 等于告诉用户「你这段时间没花钱」，那是假的。
    content = (
      <Alert>
        <Info />
        <AlertTitle>{t('Usage statistics are turned off')}</AlertTitle>
        <AlertDescription>
          {t(
            'This platform does not record usage statistics, so member usage cannot be shown here. Ask the platform administrator to enable usage data export.'
          )}
        </AlertDescription>
      </Alert>
    )
  } else {
    content = (
      <div className='space-y-4'>
        <EnterpriseUsageSummary
          totalQuota={totalQuota}
          totalCount={totalCount}
          memberCount={memberCount}
          loading={false}
        />
        <EnterpriseUsageCharts
          modelShares={modelShares}
          trend={trendPoints}
          loading={false}
        />
        <EnterpriseUsageMemberTable
          members={byMember}
          totalQuota={totalQuota}
          range={seconds}
          loading={false}
        />
      </div>
    )
  }

  return (
    <SectionPageLayout fixedContent>
      <SectionPageLayout.Title>{t('Usage')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <CompactDateTimeRangePicker
          start={pickerRange.start}
          end={pickerRange.end}
          onChange={handleRangeChange}
        />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>{content}</SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
