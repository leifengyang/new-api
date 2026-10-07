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
import { FileText, Image, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ProbeAnswerRules } from '@/features/degradation-watch/components/probe-answer-rules'
import {
  intermediateAnswer,
  probePlanSchema,
  type ProbePlan,
} from '@/features/degradation-watch/lib/probes'
import { formatNumber } from '@/lib/format'

import { ProbeTemplateFields } from './probe-template-fields'

export function ProbeTemplatesEditor({
  form,
}: {
  form: UseFormReturn<ProbePlan>
}) {
  const { t } = useTranslation()
  const plan = useWatch({ control: form.control }) as ProbePlan
  const [editing, setEditing] = useState<number | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='font-semibold'>{t('Probe templates')}</h3>
          <p className='text-muted-foreground mt-1 text-xs'>
            {t(
              'Reuse prompts across targets and override the interval for each channel.'
            )}
          </p>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={plan.probes.length >= 20}
          onClick={() => setEditing(-1)}
        >
          <Plus />
          {t('Add probe')}
        </Button>
      </div>
      {!plan.probes.length && (
        <EmptyState icon={FileText} title={t('No probe templates')} />
      )}
      <div className='grid gap-4 xl:grid-cols-2'>
        {plan.probes.map((probe, index) => (
          <section
            key={probe.id}
            className='flex min-w-0 flex-col gap-4 rounded-xl border p-4'
          >
            <div className='flex items-start gap-3'>
              <span
                className={
                  probe.kind === 'text'
                    ? 'rounded-lg bg-emerald-500/10 p-2 text-emerald-600'
                    : 'rounded-lg bg-violet-500/10 p-2 text-violet-600'
                }
              >
                {probe.kind === 'text' ? (
                  <FileText className='size-5' />
                ) : (
                  <Image className='size-5' />
                )}
              </span>
              <div className='min-w-0 flex-1'>
                <h4 className='font-medium break-all'>{probe.name}</h4>
                <p className='text-muted-foreground mt-1 text-xs'>
                  {probe.kind === 'text' ? t('Text probe') : t('Drawing check')}
                </p>
              </div>
              <Badge variant='secondary'>
                {t('Every {{minutes}} min', {
                  minutes: formatNumber(probe.interval_minutes),
                })}
              </Badge>
            </div>
            <p className='text-muted-foreground line-clamp-2 min-h-10 text-sm whitespace-pre-wrap'>
              {probe.prompt}
            </p>
            {probe.kind === 'text' && (
              <ProbeAnswerRules
                expected={probe.expected}
                intermediate={intermediateAnswer(
                  probe.expected,
                  probe.intermediate_expected
                )}
                match={probe.match}
              />
            )}
            <div className='mt-auto flex items-center justify-between border-t pt-3'>
              <span className='text-muted-foreground text-xs'>
                {t('Used by {{count}} targets', {
                  count: plan.targets.filter((target) =>
                    target.probes.some(
                      (binding) =>
                        binding.probe_id === probe.id && binding.enabled
                    )
                  ).length,
                })}
              </span>
              <div className='flex gap-1'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={() => setEditing(index)}
                >
                  {t('Edit')}
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={t('Remove')}
                  onClick={() => setRemoving(probe.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          </section>
        ))}
      </div>
      {editing !== null && (
        <ProbeTemplateDialog
          plan={plan}
          index={editing}
          onClose={() => setEditing(null)}
          onApply={(probes) => {
            form.setValue('probes', probes, { shouldDirty: true })
            setEditing(null)
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title={t('Remove')}
        confirmText={t('Remove')}
        desc={t(
          'Removing this template also removes its bindings from every target. Save changes to apply.'
        )}
        destructive
        handleConfirm={() => {
          form.setValue(
            'probes',
            plan.probes.filter((probe) => probe.id !== removing),
            { shouldDirty: true }
          )
          form.setValue(
            'targets',
            plan.targets.map((target) => ({
              ...target,
              probes: target.probes.filter(
                (binding) => binding.probe_id !== removing
              ),
            })),
            { shouldDirty: true }
          )
          setRemoving(null)
        }}
      />
    </div>
  )
}

function ProbeTemplateDialog(props: {
  plan: ProbePlan
  index: number
  onClose: () => void
  onApply: (probes: ProbePlan['probes']) => void
}) {
  const { t } = useTranslation()
  const form = useForm<ProbePlan>({
    defaultValues: {
      ...props.plan,
      probes: [
        props.index < 0
          ? {
              id: crypto.randomUUID(),
              name: '',
              kind: 'text',
              prompt: '',
              expected: '',
              match: 'exact',
              interval_minutes: 5,
            }
          : structuredClone(props.plan.probes[props.index]),
      ],
    },
  })
  const [invalid, setInvalid] = useState(false)
  const apply = () => {
    const probe = form.getValues('probes.0')
    const probes =
      props.index < 0
        ? [...props.plan.probes, probe]
        : props.plan.probes.map((item, index) =>
            index === props.index ? probe : item
          )
    const result = probePlanSchema.safeParse({ ...props.plan, probes })
    if (!result.success) {
      setInvalid(true)
      return
    }
    props.onApply(result.data.probes)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={props.index < 0 ? t('Add probe') : t('Edit probe template')}
      description={t(
        'Apply edits to the form, then save all changes to activate them.'
      )}
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
      <ProbeTemplateFields form={form} />
      {invalid && (
        <p role='alert' className='text-destructive mt-3 text-sm'>
          {t('Check the probe fields before saving')}
        </p>
      )}
    </Dialog>
  )
}
