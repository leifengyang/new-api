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

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  probePlanSchema,
  type ProbePlan,
} from '@/features/degradation-watch/lib/probes'

export function ProbeRuntimeDialog(props: {
  plan: ProbePlan
  onClose: () => void
  onApply: (values: ProbePlan) => void
}) {
  const { t } = useTranslation()
  const form = useForm<ProbePlan>({ defaultValues: props.plan })
  const [invalid, setInvalid] = useState(false)
  const apply = () => {
    const result = probePlanSchema.safeParse(form.getValues())
    if (!result.success) {
      setInvalid(true)
      return
    }
    props.onApply(result.data)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Runtime settings')}
      description={t(
        'Apply edits to the form, then save all changes to activate them.'
      )}
      contentClassName='sm:max-w-lg'
      footer={
        <>
          <Button type='button' variant='outline' onClick={props.onClose}>
            {t('Cancel')}
          </Button>
          <Button type='button' onClick={apply}>
            {t('Apply to form')}
          </Button>
        </>
      }
    >
      <div className='grid gap-5'>
        <Label className='grid gap-2'>
          {t('Concurrent requests per test type')}
          <Input
            type='number'
            min={1}
            max={32}
            {...form.register('concurrency')}
          />
        </Label>
        <Label className='grid gap-2'>
          {t('Request timeout (seconds)')}
          <Input
            type='number'
            min={30}
            max={3600}
            {...form.register('timeout_seconds')}
          />
        </Label>
        {invalid && (
          <p role='alert' className='text-destructive text-sm'>
            {t('Concurrency must be 1–32 and timeout must be 30–3600 seconds.')}
          </p>
        )}
      </div>
    </Dialog>
  )
}
