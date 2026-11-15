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
import { ArrowRight, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { formatQuotaWithCurrency } from '@/lib/currency'

import { useChampionMutation, type ChampionAward } from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'

export function ChampionHonorDialog(props: {
  award: ChampionAward
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const mutation = useChampionMutation()
  const [confirmDecline, setConfirmDecline] = useState(false)
  const claimable = props.award.status === 'claimable'
  const declined = props.award.status === 'declined'
  const badge = Math.min(props.award.position, 8)
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) props.onClose()
      }}
      showCloseButton={!mutation.isPending}
      title={t('Glory belongs to you')}
      description={t('Celebrate BLG. Share the glory.')}
      contentClassName='border-amber-200/30 bg-[#101f39] text-white shadow-2xl sm:max-w-lg motion-reduce:animate-none'
      headerClassName='items-center pt-5 text-center'
      titleClassName='font-serif text-3xl font-semibold tracking-wide text-amber-100 sm:text-4xl'
      descriptionClassName='text-slate-300'
      footerClassName='flex-col border-white/10 bg-white/5 sm:flex-col'
      footer={
        <>
          {claimable ? (
            <>
              <Button
                className='h-11 w-full bg-amber-200 text-[#101f39] hover:bg-amber-100'
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ body: { decision: 'claim' } })}
              >
                {t('Claim reward')}
              </Button>
              <Button
                variant='ghost'
                className='w-full text-slate-300 hover:bg-white/10 hover:text-white'
                disabled={mutation.isPending}
                onClick={() => setConfirmDecline(true)}
              >
                {t('Give up reward')}
              </Button>
            </>
          ) : (
            <Button
              className='h-11 w-full bg-amber-200 text-[#101f39] hover:bg-amber-100'
              render={<Link to='/profile' />}
              onClick={props.onClose}
            >
              {t('View my honors')}
              <ArrowRight className='size-4' />
            </Button>
          )}
          <Button
            variant='ghost'
            className='w-full text-slate-200 hover:bg-white/10 hover:text-white'
            disabled={mutation.isPending}
            onClick={props.onClose}
          >
            {claimable ? t('Decide later') : t('Got it')}
          </Button>
        </>
      }
    >
      <div className='flex flex-col items-center text-center'>
        <div className='relative flex size-56 items-center justify-center sm:size-64'>
          <div
            aria-hidden='true'
            className='absolute inset-4 rounded-full border border-amber-100/20 bg-radial from-amber-200/20 via-amber-200/5 to-transparent'
          />
          <div
            aria-hidden='true'
            className='absolute inset-0 rounded-full border border-amber-100/10'
          />
          <Sparkles
            aria-hidden='true'
            className='absolute top-5 right-6 size-5 text-amber-200 motion-safe:animate-pulse'
          />
          <ChampionBadge
            badge={badge}
            className='relative size-52 drop-shadow-[0_12px_24px_#0008] sm:size-60'
          />
        </div>
        <p className='mt-4 text-xs tracking-[0.3em] text-amber-100/80'>
          BLG · S16 · 2026
        </p>
        <h3 className='mt-2 font-serif text-2xl font-semibold text-amber-100'>
          {t(championTitle(badge))}
        </h3>
        <p className='mt-2 text-xs text-slate-300'>
          {t('S16 2026 · Owned permanently')}
        </p>
        <div className='mt-6 w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4'>
          <p className='text-xs text-slate-300'>
            {t('Championship activity reward')}
          </p>
          <p className='mt-1 text-3xl font-semibold text-amber-100 tabular-nums'>
            {declined
              ? t('Reward declined')
              : formatQuotaWithCurrency(props.award.quota)}
          </p>
          {claimable && (
            <p className='mt-2 text-xs leading-5 text-slate-300'>
              {t(
                'Claim to add this reward to your balance. Your permanent badges are already yours.'
              )}
            </p>
          )}
          {declined && (
            <p className='mt-2 text-xs leading-5 text-slate-300'>
              {t(
                'You gave up the balance reward. Your permanent badges remain yours.'
              )}
            </p>
          )}
          {props.award.status === 'credited' && (
            <p className='mt-2 text-xs leading-5 text-slate-300'>
              {t(
                'Your activity reward has been credited to your personal balance. Your badges are yours permanently.'
              )}
            </p>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDecline && props.open}
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirmDecline(open)
        }}
        title={t('Give up this reward?')}
        desc={t(
          'You will permanently give up {{amount}} in site balance. This cannot be undone. Your badges will remain.',
          { amount: formatQuotaWithCurrency(props.award.quota) }
        )}
        confirmText={t('Confirm giving up reward')}
        cancelBtnText={t('Keep reward')}
        destructive
        isLoading={mutation.isPending}
        handleConfirm={() =>
          mutation.mutate(
            { body: { decision: 'decline', confirm_decline: true } },
            { onSuccess: () => setConfirmDecline(false) }
          )
        }
      />
    </Dialog>
  )
}
