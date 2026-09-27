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
import { Activity, Coins, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatCard } from '@/features/dashboard/components/ui/stat-card'
import { formatCompactNumber, formatQuota } from '@/lib/format'

interface EnterpriseUsageSummaryProps {
  /** 含企业账号自己。 */
  totalQuota: number
  totalCount: number
  /** 不含企业账号自己。 */
  memberCount: number
  loading: boolean
}

/**
 * 三个数字卡。口径在面板里就算好再传进来，这里只负责显示，避免同一个「总计」
 * 在两个地方各算一遍。
 */
export function EnterpriseUsageSummary(props: EnterpriseUsageSummaryProps) {
  const { t } = useTranslation()

  return (
    <div className='grid gap-4 sm:grid-cols-3'>
      <StatCard
        title={t('Total Usage')}
        value={formatQuota(props.totalQuota)}
        description={t('Includes this enterprise account')}
        icon={Coins}
        tone='accent-1'
        loading={props.loading}
        compactMobile
      />
      <StatCard
        title={t('Requests')}
        value={formatCompactNumber(props.totalCount)}
        description={t('Requests sent by all members')}
        icon={Activity}
        tone='accent-2'
        loading={props.loading}
        compactMobile
      />
      <StatCard
        title={t('Members')}
        value={formatCompactNumber(props.memberCount)}
        description={t('Members with usage in this period')}
        icon={Users}
        tone='accent-3'
        loading={props.loading}
        compactMobile
      />
    </div>
  )
}
