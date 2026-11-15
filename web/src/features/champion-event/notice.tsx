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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CompensationNotice } from '@/features/stream-compensation/messages'
import { formatQuotaWithCurrency } from '@/lib/currency'

import { useChampionMutation, useChampionSelf } from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'

export function ChampionNotice() {
  const { t } = useTranslation()
  const query = useChampionSelf()
  const mutation = useChampionMutation()
  const [dismissed, setDismissed] = useState<number | null>(null)
  const award = query.data
  const open =
    award?.status === 'credited' &&
    award.notice_seen_at === 0 &&
    dismissed !== award.id
  const close = () => {
    if (!award) return
    setDismissed(award.id)
    mutation.mutate({ body: { seen: true } })
  }
  return (
    <>
      <CompensationNotice
        enabled={(query.isSuccess || query.isError) && !open}
      />
      <Dialog
        open={!!open}
        onOpenChange={(value) => {
          if (!value) close()
        }}
        title={t('Glory belongs to you')}
        contentClassName='sm:max-w-md'
        titleClassName='text-center font-serif text-2xl'
        footer={
          <Button
            className='w-full'
            render={<Link to='/wallet' />}
            onClick={close}
          >
            {t('View my honors')}
          </Button>
        }
      >
        {award && (
          <div className='flex flex-col items-center gap-3 py-3 text-center'>
            <ChampionBadge
              badge={Math.min(award.position, 8)}
              className='size-48'
            />
            <h3 className='text-xl font-semibold'>
              {t(championTitle(Math.min(award.position, 8)))}
            </h3>
            <p className='text-3xl font-semibold text-emerald-700 dark:text-emerald-400'>
              +{formatQuotaWithCurrency(award.quota)}
            </p>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Your activity reward has been credited to your personal balance. Your badges are yours permanently.'
              )}
            </p>
          </div>
        )}
      </Dialog>
    </>
  )
}

export function ChampionInboxLink() {
  const { t } = useTranslation()
  const { data } = useChampionSelf()
  if (data?.status !== 'credited') return null
  return (
    <Button
      className='w-full justify-between'
      variant='outline'
      render={<Link to='/wallet' />}
    >
      {t('Championship reward received')}
      {data.read_at === 0 && <Badge>{t('Unread')}</Badge>}
    </Button>
  )
}

export function EquippedChampionBadge() {
  const { t } = useTranslation()
  const { data } = useChampionSelf()
  if (data?.status !== 'credited' || !data.equipped) return null
  return (
    <Button
      size='icon'
      variant='ghost'
      className='size-8'
      render={<Link to='/profile' />}
      aria-label={t('View my honors')}
    >
      <ChampionBadge badge={data.equipped} small />
    </Button>
  )
}
