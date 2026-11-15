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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { hasChampionHonor, useChampionMutation, useChampionSelf } from './api'
import { ChampionHonorDialog } from './honor-dialog'

// Wallet keeps the financial receipt; permanent badges live beside the profile name.
export function ChampionHonors() {
  const { t } = useTranslation()
  const { data: award } = useChampionSelf()
  const mutation = useChampionMutation()
  const [open, setOpen] = useState(false)
  if (!hasChampionHonor(award)) return null
  return (
    <section className='bg-card space-y-3 rounded-xl border p-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h2 className='font-semibold'>{t('Championship activity reward')}</h2>
          <p className='text-muted-foreground mt-1 text-xs'>
            {award.credited_at > 0 &&
              dayjs.unix(award.credited_at).format('YYYY-MM-DD HH:mm')}{' '}
            · #{formatNumber(award.id)}
          </p>
        </div>
        <span className='text-xl font-semibold text-emerald-700 dark:text-emerald-400'>
          {award.status === 'declined'
            ? t('Reward declined')
            : formatQuotaWithCurrency(award.quota)}
        </span>
      </div>
      {award.status === 'claimable' && (
        <p className='text-muted-foreground text-sm'>
          {t(
            'Claim to add this reward to your balance. Your permanent badges are already yours.'
          )}
        </p>
      )}
      {award.status === 'declined' && (
        <p className='text-muted-foreground text-sm'>
          {t(
            'You gave up the balance reward. Your permanent badges remain yours.'
          )}
        </p>
      )}
      {award.status === 'credited' && (
        <p className='text-muted-foreground text-sm'>
          {t(
            'Your activity reward has been credited to your personal balance. Your badges are yours permanently.'
          )}
        </p>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        {award.status === 'claimable' && (
          <Button size='sm' onClick={() => setOpen(true)}>
            {t('Claim reward')}
          </Button>
        )}
        <Button variant='outline' size='sm' render={<Link to='/profile' />}>
          {t('View my honors')}
        </Button>
        {award.read_at === 0 && (
          <>
            <Badge>{t('Unread')}</Badge>
            <Button
              variant='ghost'
              size='sm'
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ body: { read: true } })}
            >
              {t('Mark as read')}
            </Button>
          </>
        )}
      </div>
      <ChampionHonorDialog
        award={award}
        open={open}
        onClose={() => setOpen(false)}
      />
    </section>
  )
}
