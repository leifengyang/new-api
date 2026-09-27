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
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { CompactDateTimeRangePicker } from '@/features/usage-logs/components/compact-date-time-range-picker'

import { useEnterpriseRange } from '../hooks/use-enterprise-range'
import { EnterpriseLogsTable } from './enterprise-logs-table'

/**
 * 企业成员的调用日志。范围就是本企业的成员（服务端按归属收窄，且不含企业账号
 * 自己），渠道和 IP 这类平台侧字段在服务端就已经脱敏，前端拿不到。
 */
export function EnterpriseLogsPanel() {
  const { t } = useTranslation()
  const { seconds, pickerRange, handleRangeChange } = useEnterpriseRange()

  return (
    <SectionPageLayout fixedContent>
      <SectionPageLayout.Title>{t('Member Logs')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <CompactDateTimeRangePicker
          start={pickerRange.start}
          end={pickerRange.end}
          onChange={handleRangeChange}
        />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <EnterpriseLogsTable range={seconds} />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
