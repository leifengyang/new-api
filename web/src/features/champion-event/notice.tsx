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
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CompensationNotice } from '@/features/stream-compensation/messages'
import { useAuthStore } from '@/stores/auth-store'

import { hasChampionHonor, useChampionMutation, useChampionSelf } from './api'
import { ChampionBadge } from './badge'
import { championTitle } from './badge-titles'
import { ChampionHonorDialog } from './honor-dialog'

export function ChampionNotice(props: { children?: ReactNode }) {
  const signedIn = useAuthStore((state) => !!state.auth.user)
  const query = useChampionSelf()
  const mutation = useChampionMutation()
  const [dismissed, setDismissed] = useState<number | null>(null)
  const award = query.data
  const open =
    signedIn &&
    hasChampionHonor(award) &&
    award.notice_seen_at === 0 &&
    dismissed !== award.id
  const ready = !signedIn || query.isSuccess || query.isError
  const close = () => {
    if (!award) return
    setDismissed(award.id)
    mutation.mutate({ body: { seen: true } })
  }
  return (
    <>
      {signedIn && <CompensationNotice enabled={ready && !open} />}
      {ready && !open && props.children}
      {hasChampionHonor(award) && (
        <ChampionHonorDialog award={award} open={!!open} onClose={close} />
      )}
    </>
  )
}

export function ChampionInboxLink() {
  const { t } = useTranslation()
  const { data } = useChampionSelf()
  if (!hasChampionHonor(data)) return null
  return (
    <Button
      className='w-full justify-between'
      variant='outline'
      render={<Link to='/wallet' />}
    >
      {data.status === 'credited'
        ? t('Championship reward received')
        : t('Championship activity reward')}
      {data.read_at === 0 && <Badge>{t('Unread')}</Badge>}
    </Button>
  )
}

export function ProfileChampionBadges() {
  const { t } = useTranslation()
  const { data } = useChampionSelf()
  if (!hasChampionHonor(data)) return null
  const badges = data.position <= 7 ? [data.position, 8] : [8]
  return (
    <div
      className='flex shrink-0 items-center gap-1'
      aria-label={t('My championship honors')}
    >
      {badges.map((badge) => (
        <Tooltip key={badge}>
          <TooltipTrigger
            role='link'
            render={
              <Button
                variant='ghost'
                size='icon'
                className='size-11 rounded-xl bg-amber-100/30 hover:bg-amber-100/60 dark:bg-white/5'
                render={<Link to='/championship' />}
                aria-label={t(championTitle(badge))}
              >
                <ChampionBadge badge={badge} small className='size-9' />
              </Button>
            }
          />
          <TooltipContent>
            {t(championTitle(badge))} · {t('Seven seats of honor')}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
