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
import { ViewIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DetailsDialog } from '@/features/usage-logs/components/dialogs/details-dialog'
import type { UsageLog } from '@/features/usage-logs/data/schema'

/**
 * 企业成员日志的「查看详情」入口，打开的是官方的日志详情弹窗。
 *
 * 单独成一个模块，是为了让组件身份稳定：写在列定义里的话，列的 memo 每次因
 * `t` / `locale` 重算都会得到一个新的组件类型，React 会重新挂载单元格，把用户
 * 正开着的弹窗关掉。
 *
 * isAdmin / isRoot 恒为 false：这是企业租户视图，平台侧字段在服务端就已剥掉。
 */
export function EnterpriseLogDetailsCell(props: { log: UsageLog }) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <button
        type='button'
        className='text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline'
        onClick={() => setDialogOpen(true)}
        title={t('Click to view full details')}
      >
        <HugeiconsIcon
          icon={ViewIcon}
          className='size-3'
          strokeWidth={2}
          aria-hidden='true'
        />
        {t('View details')}
      </button>
      <DetailsDialog
        log={props.log}
        isAdmin={false}
        isRoot={false}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  )
}
