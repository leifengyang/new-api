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
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  sideDrawerContentClassName,
  sideDrawerHeaderClassName,
  sideDrawerFormClassName,
  sideDrawerFooterClassName,
} from '@/components/drawer-layout'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import {
  probePlanSchema,
  type ProbePlan,
  type ProbeTarget,
} from '@/features/degradation-watch/lib/probes'
import type { DegradationWatchAvailableChannel } from '@/features/degradation-watch/types'

import { ProbeTargetFields } from './probe-target-fields'

export function ProbeTargetDrawer(props: {
  plan: ProbePlan
  index: number
  initial: ProbeTarget
  channels: DegradationWatchAvailableChannel[]
  groups: string[]
  onClose: () => void
  onApply: (targets: ProbeTarget[]) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const form = useForm<ProbePlan>({
    defaultValues: { ...props.plan, targets: [structuredClone(props.initial)] },
  })
  const [invalid, setInvalid] = useState(false)
  const apply = () => {
    const target = form.getValues('targets.0')
    if (!props.groups.includes(target.group)) {
      setInvalid(true)
      return
    }
    const targets = props.plan.targets.map((item, index) => {
      if (index === props.index) return target
      if (
        target.public &&
        item.group === target.group &&
        item.model === target.model
      ) {
        return { ...item, public: false }
      }
      return item
    })
    if (props.index < 0) targets.push(target)
    const result = probePlanSchema.safeParse({ ...props.plan, targets })
    if (!result.success) {
      setInvalid(true)
      return
    }
    props.onApply(result.data.targets)
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <SheetContent className={sideDrawerContentClassName('sm:max-w-xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle>
            {props.index < 0 ? t('Add target') : t('Configure target')}
          </SheetTitle>
          <SheetDescription>
            {t(
              'Apply edits to the form, then save all changes to activate them.'
            )}
          </SheetDescription>
        </SheetHeader>
        <div className={sideDrawerFormClassName()}>
          <ProbeTargetFields
            form={form}
            channels={props.channels}
            groups={props.groups}
          />
          {invalid && (
            <p role='alert' className='text-destructive text-sm'>
              {t('Check the target selection and public channel')}
            </p>
          )}
        </div>
        <SheetFooter className={sideDrawerFooterClassName()}>
          {props.index >= 0 && (
            <Button
              type='button'
              variant='ghost'
              className='text-destructive col-span-2 sm:mr-auto'
              onClick={props.onRemove}
            >
              {t('Remove target')}
            </Button>
          )}
          <Button type='button' variant='outline' onClick={props.onClose}>
            {t('Cancel')}
          </Button>
          <Button type='button' onClick={apply}>
            {t('Apply to form')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
