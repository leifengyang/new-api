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
import { Crown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'

import { USER_MEMBER_LEVEL, USER_MEMBER_LEVELS } from '../constants'

/**
 * 内部学员的黑金标识：近黑底、金字、金色细边，前面加一个皇冠。
 * 这套配色写死不跟随主题是有意的——「黑金」本身就是要一眼看出是特殊身份，
 * 换成跟随主题的 token 在暗色下会变成又一个普通徽章。
 */
const INTERNAL_MEMBER_BADGE_CLASS =
  'border-amber-400/40 bg-neutral-900 text-amber-300 dark:bg-neutral-950'

interface MemberLevelBadgeProps {
  /** `member_level` 的原始值，未知值不渲染，避免把未来新增的等级显示成外部用户。 */
  level: number
  className?: string
}

/** 会员等级的展示封装：后台用户列表和学员自己的返现卡片共用同一套样式。 */
export function MemberLevelBadge(props: MemberLevelBadgeProps) {
  const { t } = useTranslation()
  const config =
    USER_MEMBER_LEVELS[props.level as keyof typeof USER_MEMBER_LEVELS]

  if (!config) {
    return null
  }

  if (props.level === USER_MEMBER_LEVEL.INTERNAL) {
    return (
      <StatusBadge
        icon={Crown}
        label={t(config.labelKey)}
        copyable={false}
        className={cn('border', INTERNAL_MEMBER_BADGE_CLASS, props.className)}
      />
    )
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
