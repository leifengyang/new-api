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
import { ArrowLeft, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import blgLogo from '@/assets/champion/blg-logo.png'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PublicLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'

import {
  getChampionData,
  hasChampionHonor,
  useChampionSelf,
  type ChampionPublicData,
} from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'
import { ChampionHonorDialog } from './honor-dialog'

export function Championship() {
  const { t } = useTranslation()
  const self = useChampionSelf()
  const [replay, setReplay] = useState(false)
  const query = useQuery({
    queryKey: ['champion-event', 'public'],
    queryFn: () =>
      getChampionData<ChampionPublicData | null>('/api/champion-event'),
    staleTime: 30_000,
  })
  return (
    <PublicLayout>
      <div className='mx-auto w-full max-w-3xl space-y-5 overflow-auto p-4 sm:p-8'>
        <Button variant='ghost' size='sm' render={<Link to='/profile' />}>
          <ArrowLeft className='size-4' />
          {t('Profile')}
        </Button>
        {query.isPending && <LoadingState />}
        {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
        {query.isSuccess && !query.data && (
          <EmptyState
            title={t('Awaiting award list')}
            description={t(
              'The award list will be finalized after the activity ends. Sign in to claim your reward.'
            )}
          />
        )}
        {query.data && (
          <>
            <header className='relative overflow-hidden rounded-2xl border border-amber-200/20 bg-[#101f39] px-6 py-8 text-white sm:px-8'>
              <svg
                role='img'
                aria-label='BLG'
                viewBox='33 70 134 65'
                className='mb-5 h-10 w-24'
              >
                <image href={blgLogo} width='200' height='200' />
              </svg>
              <p className='text-xs tracking-[0.3em] text-amber-200'>
                S16 · 2026
              </p>
              <h1 className='mt-3 font-serif text-3xl font-semibold text-amber-100 sm:text-4xl'>
                {t('Seven seats of honor')}
              </h1>
              <p className='mt-3 text-sm leading-6 text-slate-300'>
                {t('Seven unique titles. One shared glory.')}
              </p>
              <p className='mt-5 text-xs text-slate-400'>
                {t('Activity period: November 14–15, 2026 (Beijing time)')}
              </p>
            </header>
            <section className='bg-card overflow-hidden rounded-2xl border'>
              <div className='flex items-center justify-between gap-3 border-b px-4 py-4 sm:px-6'>
                <h2 className='font-semibold'>{t('Championship activity')}</h2>
                <Badge variant='outline'>
                  {query.data.status === 'draft'
                    ? t('Provisional ranking')
                    : t('Final ranking')}
                </Badge>
              </div>
              <ol className='divide-y'>
                {Array.from({ length: 7 }, (_, index) => {
                  const position = index + 1
                  const winner = query.data?.winners.find(
                    (item) => item.position === position
                  )
                  return (
                    <li
                      key={position}
                      className='flex items-center gap-3 px-4 py-3 sm:gap-5 sm:px-6'
                    >
                      <span
                        className='text-muted-foreground w-5 shrink-0 text-center text-sm tabular-nums'
                        aria-label={`${t('Rank')} ${formatNumber(position)}`}
                      >
                        {formatNumber(position)}
                      </span>
                      <ChampionBadge
                        badge={position}
                        className='size-16 sm:size-20'
                      />
                      <div className='min-w-0 flex-1'>
                        <h3 className='truncate font-semibold'>
                          {winner?.name ?? t('Awaiting award list')}
                        </h3>
                        <p className='text-muted-foreground mt-1 text-xs sm:text-sm'>
                          {t(championTitle(position))}
                        </p>
                      </div>
                      {winner?.status === 'credited' && (
                        <Badge
                          variant='outline'
                          className='shrink-0 border-amber-300/50 text-amber-800 dark:text-amber-200'
                        >
                          {t('Reward credited')}
                        </Badge>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>
            <p className='text-muted-foreground px-1 text-xs leading-6'>
              {t(
                'Rankings reflect activity consumption only. All seven champion badges share the same honor level.'
              )}
            </p>
          </>
        )}
        {hasChampionHonor(self.data) && (
          <>
            <Button
              variant='outline'
              className='w-full'
              onClick={() => setReplay(true)}
            >
              <Sparkles className='size-4' />
              {t('Replay my honor moment')}
            </Button>
            <ChampionHonorDialog
              award={self.data}
              open={replay}
              onClose={() => setReplay(false)}
            />
          </>
        )}
      </div>
    </PublicLayout>
  )
}
