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
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

import { useChampionMutation, type ChampionEvent } from './api'

const schema = z.object({
  excluded: z.string().refine(
    (value) =>
      value.trim() === '' ||
      value
        .split(/[,\s]+/)
        .filter(Boolean)
        .every(
          (id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))
        ),
    'Enter positive user IDs separated by commas'
  ),
})

export function ChampionSettings(props: { event: ChampionEvent }) {
  const { t } = useTranslation()
  const mutation = useChampionMutation()
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      excluded: (JSON.parse(props.event.excluded_ids) as number[]).join(', '),
    },
  })
  const save = (published: boolean) =>
    form.handleSubmit((values) =>
      mutation.mutate({
        path: '/admin',
        body: {
          revision: props.event.revision,
          published,
          excluded_ids: values.excluded
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(Number),
        },
      })
    )()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void save(props.event.published)
      }}
      className='space-y-4 rounded-xl border p-5'
    >
      <div className='flex items-center gap-3'>
        <Switch
          id='champion-published'
          checked={props.event.published}
          disabled={mutation.isPending}
          onCheckedChange={(value) => void save(value)}
        />
        <Label htmlFor='champion-published'>
          {t('Publish championship activity')}
        </Label>
      </div>
      <div className='space-y-2'>
        <Label htmlFor='champion-excluded'>
          {t('Excluded test account IDs')}
        </Label>
        <Input
          id='champion-excluded'
          {...form.register('excluded')}
          disabled={props.event.status !== 'draft' || mutation.isPending}
          aria-invalid={!!form.formState.errors.excluded}
          placeholder='12, 34'
        />
        <p className='text-muted-foreground text-xs'>
          {t(
            'Enter test account IDs to exclude. Administrators and disabled accounts are excluded automatically.'
          )}
        </p>
        {form.formState.errors.excluded && (
          <p role='alert' className='text-destructive text-sm'>
            {t('Enter positive user IDs separated by commas')}
          </p>
        )}
      </div>
      <Button
        type='submit'
        disabled={mutation.isPending || props.event.status !== 'draft'}
      >
        {t('Save exclusions')}
      </Button>
    </form>
  )
}
