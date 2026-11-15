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
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PublicLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import {
  getChampionData,
  useChampionSelf,
  type ChampionPublicData,
} from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'

export function Championship() {
  const { t } = useTranslation()
  const self = useChampionSelf()
  const signedIn = useAuthStore((state) => !!state.auth.user)
  const query = useQuery({
    queryKey: ['champion-event', 'public'],
    queryFn: () =>
      getChampionData<ChampionPublicData | null>('/api/champion-event'),
    staleTime: 30_000,
  })
  return (
    <PublicLayout>
      <div className='mx-auto w-full max-w-6xl space-y-6 overflow-auto p-4 sm:p-8'>
        {query.isPending && <LoadingState />}
        {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
        {query.isSuccess && !query.data && (
          <EmptyState
            title={t('The championship activity is not published yet')}
          />
        )}
        {query.data && (
          <>
            <header className='relative overflow-hidden rounded-2xl bg-[#101f39] p-6 text-white sm:p-10'>
              <div className='flex flex-col items-center gap-6 sm:flex-row sm:justify-between'>
                <div className='max-w-xl space-y-4'>
                  <Badge className='border border-amber-200/50 bg-transparent text-amber-100'>
                    S16 · 2026
                  </Badge>
                  <h1 className='font-serif text-3xl font-semibold sm:text-4xl'>
                    {t('Celebrate BLG. Share the glory.')}
                  </h1>
                  <p className='text-sm leading-7 text-slate-200'>
                    {t(
                      'The top seven receive $66.60 each and a unique champion badge. All other eligible participants receive $1.00 and a permanent commemorative badge.'
                    )}
                  </p>
                  <p className='text-xs text-slate-300'>
                    {t('Activity period: November 14–15, 2026 (Beijing time)')}
                  </p>
                </div>
                <ChampionBadge badge={3} className='size-48 sm:size-56' />
              </div>
            </header>
            <section className='space-y-4'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <h2 className='text-xl font-semibold'>
                  {t('Seven seats of honor')}
                </h2>
                <Badge variant='outline'>
                  {query.data.status === 'draft'
                    ? t('Provisional ranking')
                    : t('Final ranking')}
                </Badge>
              </div>
              <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4'>
                {Array.from({ length: 7 }, (_, index) => {
                  const position = index + 1
                  const winner = query.data?.winners.find(
                    (item) => item.position === position
                  )
                  return (
                    <article
                      key={position}
                      className='bg-card flex flex-col items-center gap-2 rounded-xl border p-4 text-center'
                    >
                      <ChampionBadge
                        badge={position}
                        className='size-32 sm:size-40'
                      />
                      <h3 className='font-semibold'>
                        {t(championTitle(position))}
                      </h3>
                      <p className='text-muted-foreground text-sm'>
                        {winner?.name ?? t('Awaiting award list')}
                      </p>
                    </article>
                  )
                })}
              </div>
            </section>
            <section className='bg-card grid gap-5 rounded-xl border p-5 sm:grid-cols-[1fr_auto]'>
              <div className='space-y-3'>
                <h2 className='font-semibold'>{t('My activity progress')}</h2>
                {!signedIn && (
                  <Button
                    render={
                      <Link
                        to='/sign-in'
                        search={{ redirect: '/championship' }}
                      />
                    }
                  >
                    {t('Sign in')}
                  </Button>
                )}
                {signedIn && self.isPending && <LoadingState />}
                {signedIn && self.isError && (
                  <ErrorState onRetry={() => void self.refetch()} />
                )}
                {self.isSuccess && !self.data && (
                  <p className='text-muted-foreground text-sm'>
                    {t(
                      'No eligible activity consumption in the current snapshot.'
                    )}
                  </p>
                )}
                {self.data && (
                  <>
                    <p>
                      {t('Activity consumption')}:{' '}
                      {formatQuotaWithCurrency(self.data.spend)}
                    </p>
                    <p>
                      {t('Rank')}:{' '}
                      {self.data.position > 0
                        ? formatNumber(self.data.position)
                        : t('Not eligible')}
                    </p>
                  </>
                )}
                {!!query.data.snapshot_at && (
                  <p className='text-muted-foreground text-xs'>
                    {t('Ranking snapshot')}:{' '}
                    {dayjs
                      .unix(query.data.snapshot_at)
                      .format('YYYY-MM-DD HH:mm:ss')}
                  </p>
                )}
              </div>
              <div className='flex items-center gap-3'>
                <ChampionBadge badge={8} className='size-24' />
                <span className='text-sm'>
                  {t('Championship commemorative badge')}
                </span>
              </div>
            </section>
            <section className='text-muted-foreground space-y-3 text-sm leading-6'>
              <h2 className='text-foreground font-semibold'>
                {t('Activity rules')}
              </h2>
              <p>
                {t(
                  'Ranking uses original personal-wallet consumption, without subtracting refunds or stream compensation. Enterprise-funded and subscription usage is excluded. Administrators, test accounts and disabled accounts are not eligible.'
                )}
              </p>
              <p>
                {t(
                  'Ties are decided by who reached the final consumption first, then by user ID. The administrator reviews the final list after the deadline. Rewards are site balance, not cash.'
                )}
              </p>
            </section>
          </>
        )}
      </div>
    </PublicLayout>
  )
}
