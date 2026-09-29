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
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatInviteRebatePercent } from '@/features/system-settings/general/invite-rebate-rate'
import { MemberLevelBadge } from '@/features/users/components/member-level-badge'
import {
  REBATE_REVIEW_STATUS,
  USER_MEMBER_LEVEL,
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
 * what came in and where it came from. An internal member whose review has not
 * passed sees what is waiting instead, held in the frozen column.
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
  // 内部学员和外部用户拿的是两个独立比例：自己直属下线那一笔走 ①/②，再往上一层
  // 走 ③。
  const directRate = isInternal
    ? (data?.rate_basis_points ?? 0)
    : (data?.external_rate_basis_points ?? 0)
  const uplineRate = data?.internal_referrer_rate_basis_points ?? 0
  const rebateCount = summary?.rebate_count ?? 0
  const frozenQuota = summary?.frozen_quota ?? 0
  // 内部学员的返现要审核通过才能动用。未通过之前，算出来的返现依旧按笔记着，但
  // 钱不进余额——所以这里先看身份，再看审核状态，外部账号不显示这些。
  const isRebateFrozenHere =
    isInternal && data?.rebate_review_status !== REBATE_REVIEW_STATUS.APPROVED

  // 「累计返现」只算已入账的部分，冻结的不算进去——它还没到账。冻结金额单列一格，
  // 标成警告色，免得学员把两笔钱看成同一笔。
  const stats: { label: string; value: string; tone?: 'warning' }[] = [
    { label: t('Total Earned'), value: formatQuota(summary?.total_quota ?? 0) },
    ...(isRebateFrozenHere
      ? [
          {
            label: t('Frozen'),
            value: formatQuota(frozenQuota),
            tone: 'warning' as const,
          },
        ]
      : []),
    { label: t('Rebates'), value: String(rebateCount) },
    { label: t('Invites'), value: String(inviteCount) },
  ]

  // 总开关、管理员不参与、内部与外部两种返现口径要分开讲，否则用户只看到一串 0
  // 却不知道卡在哪一步。外部用户只讲他们自己的口径，内部学员多拿 ③ 这件事不能
  // 让他们知道。
  let note = isInternal
    ? t(
        'You earn {{direct}} of every top-up made by the members you invited, plus {{upline}} of every top-up made by the members they invite.',
        {
          direct: formatInviteRebatePercent(directRate),
          upline: formatInviteRebatePercent(uplineRate),
        }
      )
    : t('You earn {{rate}} of every top-up made by the members you invited.', {
        rate: formatInviteRebatePercent(directRate),
      })
  if (!data?.rebate_enabled) {
    note = t('Invite rebates are currently disabled.')
  } else if (!canEarn) {
    note = t('Administrators do not earn invite rebates.')
  } else if (isRebateFrozenHere) {
    // 冻结这件事比比例更要紧，会让人以为钱已经到账了，所以盖掉比例那段说明。
    note = t(
      'Rebates are credited once your review has passed. Until then they stay frozen.'
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
                <MemberLevelBadge
                  level={USER_MEMBER_LEVEL.INTERNAL}
                  className='shrink-0'
                />
              )}
            </div>
            <p className='text-muted-foreground mt-1 line-clamp-2 text-xs'>
              {note}
            </p>
          </div>
        </div>

        {/* 冻结金额只在真有冻结的时候才占一列，否则这一格永远是 0，看不出重点。 */}
        <div
          className={`grid gap-1.5 text-center ${
            isRebateFrozenHere ? 'grid-cols-4' : 'grid-cols-3'
          }`}
        >
          {stats.map(({ label, value, tone }) => (
            <div key={label}>
              <div
                className={`truncate text-[10px] font-medium tracking-wider uppercase ${
                  tone === 'warning' ? 'text-warning' : 'text-muted-foreground'
                }`}
              >
                {label}
              </div>
              <div
                className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${
                  tone === 'warning' ? 'text-warning' : ''
                }`}
              >
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
          {(rebateCount > 0 || frozenQuota > 0) && (
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
