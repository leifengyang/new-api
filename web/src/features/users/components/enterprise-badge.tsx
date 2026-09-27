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
import { Building2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'

interface EnterpriseBadgeProps {
  className?: string
}

/**
 * 「企业账号」标记的展示。跟会员等级一样是一个后台打的标记，所以并排放在同一
 * 列里；配色用 info 系，跟内部学员的黑金徽章区分开，也不再占用紫色。
 */
export function EnterpriseBadge(props: EnterpriseBadgeProps) {
  const { t } = useTranslation()

  return (
    <StatusBadge
      icon={Building2}
      label={t('Enterprise')}
      copyable={false}
      className={cn(
        'border border-info/30 bg-info/10 font-normal text-info',
        props.className
      )}
    />
  )
}
