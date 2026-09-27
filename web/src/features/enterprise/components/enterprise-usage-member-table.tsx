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
import { ListTree } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCompactNumber, formatPercent, formatQuota } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import type { EnterpriseUsageRange, EnterpriseUsageRow } from '../types'
import { MemberUsageDialog } from './dialogs/member-usage-dialog'

interface EnterpriseUsageMemberTableProps {
  members: EnterpriseUsageRow[]
  totalQuota: number
  range: EnterpriseUsageRange
  loading: boolean
}

/**
 * 按成员的用量表。数据是一次全量取回来的（成员上限 100，不需要分页），
 * 所以用静态表格而不是 DataTablePage 那套服务端分页。
 */
export function EnterpriseUsageMemberTable(
  props: EnterpriseUsageMemberTableProps
) {
  const { t } = useTranslation()
  const currentUserId = useAuthStore((state) => state.auth.user?.id)
  const [activeMember, setActiveMember] = useState<EnterpriseUsageRow | null>(
    null
  )
  const [dialogOpen, setDialogOpen] = useState(false)

  const openMember = (member: EnterpriseUsageRow) => {
    setActiveMember(member)
    setDialogOpen(true)
  }

  return (
    <Card className='overflow-hidden'>
      <CardHeader>
        <CardTitle className='inline-flex items-center gap-2 text-base'>
          <ListTree className='text-primary size-4' />
          {t('Usage by Member')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {props.loading ? (
          <Skeleton className='h-40 w-full' />
        ) : (
          <StaticDataTable
            data={props.members}
            getRowKey={(row) => String(row.user_id)}
            empty
            emptyContent={
              <span className='text-muted-foreground text-sm'>
                {t('No usage in this period')}
              </span>
            }
            columns={[
              {
                id: 'username',
                header: t('Username'),
                cell: (row) => (
                  <span className='inline-flex items-center gap-2'>
                    <span className='text-sm font-normal'>
                      {row.username || `#${row.user_id}`}
                    </span>
                    {row.user_id === currentUserId && (
                      <Badge variant='secondary' className='font-normal'>
                        {t('This account')}
                      </Badge>
                    )}
                  </span>
                ),
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
                id: 'token_used',
                header: t('Tokens'),
                className: 'text-right',
                cell: (row) => (
                  <span className='font-mono text-sm tabular-nums'>
                    {formatCompactNumber(row.token_used)}
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
                    {/* formatPercent 收的是百分数，这里把 0~1 的比值换算过去。 */}
                    {formatPercent(
                      props.totalQuota > 0
                        ? (row.quota / props.totalQuota) * 100
                        : 0
                    )}
                  </span>
                ),
              },
              {
                id: 'actions',
                header: t('Actions'),
                className: 'text-right',
                cell: (row) => (
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => openMember(row)}
                  >
                    <ListTree className='size-4' />
                    {t('By model')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </CardContent>

      <MemberUsageDialog
        member={activeMember}
        range={props.range}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            setActiveMember(null)
          }
        }}
      />
    </Card>
  )
}
