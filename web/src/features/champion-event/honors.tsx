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
import { Link } from '@tanstack/react-router'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { useChampionMutation, useChampionSelf } from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'

export function ChampionHonors() {
  const { t } = useTranslation()
  const query = useChampionSelf()
  const mutation = useChampionMutation()
  const award = query.data
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  const earned = award?.status === 'credited'
  const badges = earned && award.position <= 7 ? [award.position, 8] : [8]
  return (
    <section className='bg-card space-y-5 rounded-xl border p-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h2 className='text-lg font-semibold'>{t('My championship honors')}</h2>
        <Button
          variant='outline'
          size='sm'
          render={<Link to='/championship' />}
        >
          {t('View championship activity')}
        </Button>
      </div>
      {!earned && (
        <EmptyState
          title={t('No championship reward yet')}
          description={t(
            'Rewards and permanent badges appear here after the administrator confirms the award list.'
          )}
        />
      )}
      {earned && (
        <>
          <div className='grid gap-4 sm:grid-cols-2'>
            {badges.map((badge) => (
              <div
                key={badge}
                className='flex min-w-0 items-center gap-3 rounded-xl border border-amber-200/50 bg-linear-to-br from-amber-50/70 to-transparent p-3 dark:from-amber-950/20'
              >
                <ChampionBadge badge={badge} className='size-24 sm:size-32' />
                <div className='min-w-0 space-y-2'>
                  <h3 className='font-semibold'>{t(championTitle(badge))}</h3>
                  <p className='text-muted-foreground text-xs'>
                    {t('S16 2026 · Owned permanently')}
                  </p>
                  {badge < 8 && <Badge variant='outline'>NO.0{badge}</Badge>}
                  <div>
                    <Button
                      size='sm'
                      variant={
                        award.equipped === badge ? 'secondary' : 'outline'
                      }
                      disabled={mutation.isPending || award.equipped === badge}
                      onClick={() =>
                        mutation.mutate({ body: { equipped: badge } })
                      }
                    >
                      {award.equipped === badge
                        ? t('Equipped')
                        : t('Equip badge')}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Button
            variant='ghost'
            size='sm'
            disabled={mutation.isPending || award.equipped === 0}
            onClick={() => mutation.mutate({ body: { equipped: 0 } })}
          >
            {award.equipped === 0
              ? t('Badge hidden')
              : t('Hide equipped badge')}
          </Button>
          <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4'>
            <div>
              <h3 className='font-medium'>
                {t('Championship activity reward')}
              </h3>
              <p className='text-muted-foreground text-xs'>
                {dayjs.unix(award.credited_at).format('YYYY-MM-DD HH:mm')} · #
                {formatNumber(award.id)}
              </p>
            </div>
            <span className='text-xl font-semibold text-emerald-700 dark:text-emerald-400'>
              +{formatQuotaWithCurrency(award.quota)}
            </span>
          </div>
          <div className='space-y-2 border-t pt-4'>
            <div className='flex items-center gap-2'>
              <h3 className='font-medium'>
                {t('Championship reward received')}
              </h3>
              {award.read_at === 0 && <Badge>{t('Unread')}</Badge>}
            </div>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Your activity reward has been credited to your personal balance. Your badges are yours permanently.'
              )}
            </p>
            {award.read_at === 0 && (
              <Button
                size='sm'
                variant='outline'
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ body: { read: true } })}
              >
                {t('Mark as read')}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
