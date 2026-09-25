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
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { IconBadge, type IconBadgeTone } from '@/components/ui/icon-badge'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export function DetailRow(props: {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  muted?: boolean
}) {
  return (
    <div className='grid min-w-0 grid-cols-[5.25rem_minmax(0,1fr)] gap-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3'>
      <span className='text-muted-foreground min-w-0 text-xs'>
        {props.label}
      </span>
      <span
        className={cn(
          'max-w-full min-w-0 text-xs break-all sm:wrap-break-word',
          props.mono && 'font-mono',
          props.muted && 'text-muted-foreground'
        )}
      >
        {props.value}
      </span>
    </div>
  )
}

export function DetailSection(props: {
  icon?: ReactNode
  iconTone?: IconBadgeTone
  label: string
  variant?: 'default' | 'danger'
  children: ReactNode
}) {
  const isDanger = props.variant === 'danger'
  const iconTone = isDanger ? 'destructive' : props.iconTone
  return (
    <div className='min-w-0 space-y-1.5'>
      <Label
        className={cn(
          'flex items-center gap-1.5 text-xs font-semibold',
          isDanger && 'text-red-500'
        )}
      >
        {props.icon && (
          <IconBadge tone={iconTone} size='xs'>
            {props.icon}
          </IconBadge>
        )}
        {props.label}
      </Label>
      <div
        className={cn(
          'min-w-0 space-y-1 overflow-hidden rounded-md border p-2.5 max-sm:p-2',
          isDanger
            ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/20'
            : 'bg-muted/30'
        )}
      >
        {props.children}
      </div>
    </div>
  )
}

/**
 * A section of secondary detail, collapsed by default so the part of the log
 * that answers "what was I charged for" stays above the fold. The summary line
 * always states how many sections it holds, so nothing is hidden silently.
 */
export function DetailCollapsible(props: {
  label: string
  sectionCount: number
  children: ReactNode
}) {
  const { t } = useTranslation()
  const countLabel = t('{{count}} sections', { count: props.sectionCount })

  return (
    <Collapsible className='min-w-0'>
      <CollapsibleTrigger
        // The label and the count are separate flex children, so the gathered
        // accessible name would run them together without this.
        aria-label={`${props.label}, ${countLabel}`}
        className='hover:bg-muted/50 group flex w-full items-center gap-1.5 rounded-md border px-2.5 py-2 text-start text-xs font-semibold transition-colors'
      >
        <ChevronRight
          className='text-muted-foreground size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90'
          aria-hidden='true'
        />
        <span className='min-w-0 flex-1 truncate'>{props.label}</span>
        <span className='text-muted-foreground shrink-0 text-[11px] font-normal'>
          {countLabel}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='min-w-0 data-open:pt-2.5'>
        <div className='min-w-0 space-y-2.5 sm:space-y-3'>{props.children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
