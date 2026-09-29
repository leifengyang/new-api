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

import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'

import { REBATE_REVIEW_STATUSES } from '../constants'

interface RebateReviewBadgeProps {
  /** `rebate_review_status` 的原始值。未知值不渲染，避免把后端新增的状态显示成「未审核」。 */
  status: string
  className?: string
}

/**
 * 返现审核状态的展示。只有内部会员需要审核，所以这枚徽章只挂在内部会员身上：
 * 外部账号不参与返现，给它显示「未审核」会让人以为还有一笔钱压着。
 */
export function RebateReviewBadge(props: RebateReviewBadgeProps) {
  const { t } = useTranslation()
  const config =
    REBATE_REVIEW_STATUSES[props.status as keyof typeof REBATE_REVIEW_STATUSES]

  if (!config) {
    return null
  }

  return (
    <StatusBadge
      label={t(config.labelKey)}
      variant={config.variant}
      copyable={false}
      className={cn('font-normal', props.className)}
    />
  )
}
