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
import { Share2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatInviteRebatePercent } from '@/features/system-settings/general/invite-rebate-rate'
import {
  USER_MEMBER_LEVEL,
  USER_MEMBER_LEVELS,
} from '@/features/users/constants'
import { formatQuota } from '@/lib/format'

import { useSelfInviteRebates } from '../hooks/use-self-invite-rebates'
import { SelfRebateDetailsDialog } from './self-rebate-details-dialog'

interface SelfRebateCardProps {
  affiliateLink: string
  /** Successful invites, whether or not they have topped up yet. */
  inviteCount: number
  loading?: boolean
}

/**
 * The member's view of the invite rebate programme. Rebates land on the balance
 * as they are earned, so there is nothing to claim here — this card reports
 * what came in and where it came from.
 */
export function SelfRebateCard({
  affiliateLink,
  inviteCount,
  loading,
}: SelfRebateCardProps) {
  const { t } = useTranslation()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const { data, isLoading } = useSelfInviteRebates()

  if (loading || isLoading) {
    return (
      <Card data-card-hover='false' className='bg-muted/20 py-0'>
        <CardContent className='grid gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(220px,1fr)_minmax(220px,0.72fr)_minmax(320px,1.15fr)] lg:items-center'>
          <div>
            <Skeleton className='h-5 w-32' />
            <Skeleton className='mt-2 h-4 w-48' />
          </div>
          <Skeleton className='h-14 rounded-lg' />
          <Skeleton className='h-10 rounded-lg' />
        </CardContent>
      </Card>
    )
  }

  const summary = data?.summary
  const isInternal =
    (data?.member_level ?? USER_MEMBER_LEVEL.EXTERNAL) ===
    USER_MEMBER_LEVEL.INTERNAL
  const canEarn = data?.rebate_available === true
  const rate = data?.rate_basis_points ?? 0
  const rebateCount = summary?.rebate_count ?? 0

  // 总开关、内部身份、以及「有身份也没返现」要分开讲，否则学员只看到一串 0
  // 却不知道卡在哪一步。
  let note = t(
    'You earn {{rate}} of every top-up made by the members you invited.',
    { rate: formatInviteRebatePercent(rate) }
  )
  if (!data?.rebate_enabled) {
    note = t('Invite rebates are currently disabled.')
  } else if (!canEarn) {
    note = t(
      'Only internal members earn rebates. Ask an administrator to upgrade your account.'
    )
  }

  return (
    <Card data-card-hover='false' className='bg-muted/20 py-0'>
      <CardContent className='grid gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-[minmax(200px,1fr)_minmax(180px,0.65fr)_minmax(280px,1fr)] lg:items-center'>
        <div className='flex min-w-0 items-center gap-2.5'>
          <IconBadge tone='chart-3'>
            <Share2 />
          </IconBadge>
          <div className='min-w-0'>
            <div className='flex min-w-0 items-center gap-2'>
              <h3 className='truncate text-sm font-semibold'>
                {t('Invite Rebates')}
              </h3>
              {isInternal && (
                <StatusBadge
                  label={t(
                    USER_MEMBER_LEVELS[USER_MEMBER_LEVEL.INTERNAL].labelKey
                  )}
                  variant={
                    USER_MEMBER_LEVELS[USER_MEMBER_LEVEL.INTERNAL].variant
                  }
                  copyable={false}
                  className='shrink-0 font-normal'
                />
              )}
            </div>
            <p className='text-muted-foreground mt-1 line-clamp-2 text-xs'>
              {note}
            </p>
          </div>
        </div>

        <div className='grid grid-cols-3 gap-1.5 text-center'>
          {[
            [t('Total Earned'), formatQuota(summary?.total_quota ?? 0)],
            [t('Rebates'), String(rebateCount)],
            [t('Invites'), String(inviteCount)],
          ].map(([label, value]) => (
            <div key={label}>
              <div className='text-muted-foreground truncate text-[10px] font-medium tracking-wider uppercase'>
                {label}
              </div>
              <div className='mt-0.5 truncate text-sm font-semibold tabular-nums'>
                {value}
              </div>
            </div>
          ))}
        </div>

        <div className='flex items-center gap-2'>
          <Input
            value={affiliateLink}
            readOnly
            className='border-muted bg-background/70 h-9 min-w-0 flex-1 font-mono text-xs'
          />
          <CopyButton
            value={affiliateLink}
            variant='outline'
            className='bg-background size-9 shrink-0'
            iconClassName='size-4'
            tooltip={t('Copy referral link')}
            aria-label={t('Copy referral link')}
          />
          {rebateCount > 0 && (
            <Button
              variant='outline'
              onClick={() => setDetailsOpen(true)}
              className='h-9 shrink-0 px-3'
              size='sm'
            >
              {t('Details')}
            </Button>
          )}
        </div>
      </CardContent>

      <SelfRebateDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </Card>
  )
}
