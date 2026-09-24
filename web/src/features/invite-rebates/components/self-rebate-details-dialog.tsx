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
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { TimestampCell } from '@/components/activity-time-cell'
import { Dialog } from '@/components/dialog'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatInviteRebatePercent } from '@/features/system-settings/general/invite-rebate-rate'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuota } from '@/lib/format'

import {
  INVITE_REBATE_STATUS,
  INVITE_REBATE_STATUSES,
  getSkipReasonLabel,
} from '../constants'
import {
  SELF_REBATES_PAGE_SIZE,
  useSelfInviteRebates,
} from '../hooks/use-self-invite-rebates'
import type { InviteRebate } from '../types'

interface SelfRebateDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function RebateRow(props: { rebate: InviteRebate; locale?: string }) {
  const { t } = useTranslation()
  const { rebate, locale } = props
  const statusConfig =
    INVITE_REBATE_STATUSES[rebate.status as keyof typeof INVITE_REBATE_STATUSES]

  return (
    <li className='flex flex-col gap-1 border-b py-3 first:pt-0 last:border-b-0 last:pb-0'>
      <div className='flex items-center justify-between gap-3'>
        {/* 下线用户名由后端脱敏，邀请人只看得到自己拉到了人。 */}
        <span className='min-w-0 truncate text-sm font-medium'>
          {rebate.invitee_name}
        </span>
        <span className='shrink-0 text-sm font-semibold tabular-nums'>
          +{formatQuota(rebate.rebate_quota)}
        </span>
      </div>
      <div className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
        <span className='tabular-nums'>
          {t('Top-up Amount')}: {formatQuota(rebate.base_quota)}
        </span>
        <span aria-hidden='true'>·</span>
        <span className='tabular-nums'>
          {t('Rate')}: {formatInviteRebatePercent(rebate.rate_basis_points)}
        </span>
        <span aria-hidden='true'>·</span>
        <TimestampCell
          timestamp={rebate.created_at}
          format='absolute'
          locale={locale}
          justNowLabel={t('Just now')}
        />
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        {statusConfig ? (
          <StatusBadge
            label={t(statusConfig.labelKey)}
            variant={statusConfig.variant}
            copyable={false}
            className='font-normal'
          />
        ) : null}
        {rebate.status === INVITE_REBATE_STATUS.SKIPPED && (
          <span className='text-muted-foreground text-xs'>
            {getSkipReasonLabel(rebate.skip_reason, t)}
          </span>
        )}
        {rebate.reversed_quota > 0 && (
          <span className='text-muted-foreground text-xs tabular-nums'>
            {t('Reversed: {{amount}}', {
              amount: formatQuota(rebate.reversed_quota),
            })}
          </span>
        )}
      </div>
    </li>
  )
}

/**
 * The member's own rebate list. The downline is masked by the backend, so this
 * dialog only has to render what it is given.
 */
export function SelfRebateDetailsDialog({
  open,
  onOpenChange,
}: SelfRebateDetailsDialogProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [page, setPage] = useState(1)
  const { data, isLoading } = useSelfInviteRebates({ page, enabled: open })

  // 重新打开时从第一页看起，免得停在上次翻到的位置。
  useEffect(() => {
    if (open) setPage(1)
  }, [open])

  const rebates = data?.page.items ?? []
  const total = data?.page.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / SELF_REBATES_PAGE_SIZE))

  let body: ReactNode
  if (isLoading) {
    body = (
      <div className='space-y-3'>
        <Skeleton className='h-12 w-full' />
        <Skeleton className='h-12 w-full' />
        <Skeleton className='h-12 w-full' />
      </div>
    )
  } else if (rebates.length === 0) {
    body = (
      <p className='text-muted-foreground py-6 text-center text-sm'>
        {t('Your rebates appear here after someone you invited tops up.')}
      </p>
    )
  } else {
    body = (
      <ul className='flex flex-col'>
        {rebates.map((rebate) => (
          <RebateRow key={rebate.id} rebate={rebate} locale={locale} />
        ))}
      </ul>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Invite Rebates')}
      description={t(
        'Every rebate credited for a top-up made by someone you invited.'
      )}
      bodyClassName='min-h-[120px]'
      footer={
        <>
          <span className='text-muted-foreground me-auto text-xs tabular-nums'>
            {t('Page')} {page} / {totalPages}
          </span>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1 || isLoading}
          >
            {t('Previous')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setPage((current) => current + 1)}
            disabled={page >= totalPages || isLoading}
          >
            {t('Next')}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}
