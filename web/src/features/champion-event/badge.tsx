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
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import badgeAtlas from '@/assets/champion/badges.png'
import { cn } from '@/lib/utils'

import { championTitle } from './badge-titles'

// The miniature mark drops inscriptions and bevel detail, retaining each
// role's silhouette. The large enamel atlas follows the approved artwork.
const motifs = [
  'M8 17 13 9 16 13 20 7 19 17Z',
  'M8 9 12 7 10 16 8 18ZM14 8 18 6 15 16 12 18ZM20 9 23 7 20 16 17 18Z',
  'M16 6 18 11 23 13 18 15 16 20 14 15 9 13 14 11Z',
  'M9 19 19 9 15 9 23 5 22 13 20 10 11 21Z',
  'M15 12 6 8 8 14 14 17 16 21 18 17 24 14 26 8 17 12Z',
  'M10 7 13 7 13 10 15 10 15 7 18 7 18 10 20 10 20 7 23 7 22 13 19 13 20 19 23 21 9 21 12 19 13 13 10 13Z',
  'M16 5Q23 10 19 14L18 21H14L13 14Q8 10 16 5Z',
  'M16 6 19 11 25 13 19 16 16 22 13 16 7 13 13 11Z',
]

export function ChampionBadge(props: {
  badge: number
  small?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  const index = Math.max(0, Math.min(7, props.badge - 1))
  if (props.small) {
    const silver = index === 7
    return (
      <svg
        viewBox='0 0 32 36'
        role='img'
        aria-label={t(championTitle(props.badge))}
        className={cn('size-7 shrink-0', props.className)}
      >
        <defs>
          <linearGradient id={id} x2='1' y2='1'>
            <stop stopColor={silver ? '#eef7ff' : '#fff0b5'} />
            <stop offset='1' stopColor={silver ? '#668eac' : '#a97620'} />
          </linearGradient>
        </defs>
        <path
          d='M3 7 8 8 7 2 14 6 16 0 18 6 25 2 24 8 29 7 27 25 16 34 5 25Z'
          fill={`url(#${id})`}
        />
        <path d='M6 10 16 12 26 10 24 24 16 30 8 24Z' fill='#142c4b' />
        <path
          d={motifs[index]}
          transform='translate(0 6) scale(1 .9)'
          fill={`url(#${id})`}
        />
      </svg>
    )
  }
  return (
    <span
      role='img'
      aria-label={t(championTitle(props.badge))}
      className={cn(
        'inline-block size-36 shrink-0 bg-size-[400%_200%] bg-no-repeat motion-safe:transition-transform motion-safe:duration-200 motion-safe:hover:scale-105',
        props.className
      )}
      style={{
        backgroundImage: `url(${badgeAtlas})`,
        backgroundPosition: `${((index % 4) * 100) / 3}% ${index < 4 ? 0 : 100}%`,
      }}
    />
  )
}
