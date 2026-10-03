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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Plus, Play, Save, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { PasswordInput } from '@/components/password-input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { formatTimestampToDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import { useDegradationWatchPrompt } from '../hooks/use-degradation-watch'
import {
  comparisonRequest,
  comparisonSchema,
  latestComparisonAttempts,
  newTestGroup,
  type ComparisonAttempt,
  type ComparisonDetail,
  type ComparisonInput,
  type ComparisonRound,
  type TestGroup,
} from '../lib/comparison'
import { migrateSelfTestSettings } from '../lib/storage'
import { ComparisonGroupEditor } from './comparison-group-editor'
import { ComparisonResult } from './comparison-results'
import { LegacySelfTests } from './legacy-self-tests'

export function SelfTestPanel() {
  const userID = useAuthStore((state) => state.auth.user?.id)
  return <ComparisonWorkspace key={userID} userID={userID} />
}

function ComparisonWorkspace(props: { userID: number | undefined }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const prompt = useDegradationWatchPrompt()
  const [initialized, setInitialized] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [retry, setRetry] = useState<ComparisonAttempt | null>(null)
  const [retryKey, setRetryKey] = useState('')
  const [stopAll, setStopAll] = useState(false)
  const key = ['self-test', props.userID]
  const profiles = useQuery({
    queryKey: [...key, 'profiles'],
    queryFn: () => comparisonRequest<TestGroup[]>('/profiles'),
  })
  const history = useQuery({
    queryKey: [...key, 'rounds'],
    queryFn: () => comparisonRequest<ComparisonRound[]>('/rounds'),
    refetchInterval: 3000,
  })
  const roundID = selected ?? history.data?.[0]?.id
  const detail = useQuery({
    queryKey: [...key, 'round', roundID],
    queryFn: () => comparisonRequest<ComparisonDetail>(`/rounds/${roundID}`),
    enabled: !!roundID,
    refetchInterval: (query) =>
      query.state.data?.round.status === 'running' ? 1000 : false,
  })
  const form = useForm<ComparisonInput>({
    resolver: zodResolver(comparisonSchema),
    defaultValues: {
      groups: [newTestGroup()],
      prompt: '',
      concurrency: 3,
      timeout_seconds: 1200,
    },
  })
  const groups = useFieldArray({ control: form.control, name: 'groups' })
  useEffect(() => {
    if (initialized || !profiles.data || !prompt.data) return
    const legacy = migrateSelfTestSettings()
    form.reset({
      groups: profiles.data.length
        ? profiles.data.map((group) => ({
            ...group,
            max_output_tokens: group.max_output_tokens ?? 32768,
            api_key: '',
          }))
        : [
            {
              ...newTestGroup(),
              name: t('Group {{number}}', { number: 1 }),
              base_url: legacy.baseUrl ?? '',
              model: legacy.model || prompt.data.targets[0]?.model || '',
            },
          ],
      prompt: prompt.data.prompt,
      concurrency: 3,
      timeout_seconds: 1200,
    })
    setInitialized(true)
  }, [initialized, profiles.data, prompt.data, form, t])
  const mutation = useMutation({
    mutationFn: async (action: {
      kind: 'start' | 'save' | 'stop' | 'retry'
      input?: ComparisonInput
      attemptID?: number
    }) => {
      if (action.kind === 'start') {
        const round = await comparisonRequest<ComparisonRound>(
          '/rounds',
          'post',
          action.input
        )
        setSelected(round.id)
      } else if (action.kind === 'save') {
        await comparisonRequest('/profiles', 'put', {
          groups: form.getValues('groups'),
        })
      } else if (action.kind === 'stop') {
        await comparisonRequest(`/rounds/${roundID}/stop`, 'post', {
          attempt_id: action.attemptID ?? 0,
        })
        setStopAll(false)
      } else {
        await comparisonRequest(`/attempts/${action.attemptID}/retry`, 'post', {
          api_key: retryKey,
        })
        setRetry(null)
        setRetryKey('')
      }
      if (action.kind === 'save' || action.kind === 'start') {
        const saved = await comparisonRequest<TestGroup[]>('/profiles')
        const current = form.getValues()
        form.reset({
          ...current,
          groups: saved.map((group, index) => ({
            ...group,
            max_output_tokens: group.max_output_tokens ?? 32768,
            api_key:
              action.kind === 'start'
                ? ''
                : (current.groups[index]?.api_key ?? ''),
          })),
        })
      }
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
  })
  if (profiles.isLoading || prompt.isLoading) return <LoadingState />
  if (profiles.isError || prompt.isError) {
    return (
      <ErrorState
        title={t('Failed to load the self-test')}
        onRetry={() => {
          void profiles.refetch()
          void prompt.refetch()
        }}
      />
    )
  }
  const latest = latestComparisonAttempts(detail.data?.attempts ?? [])
  const active =
    history.data?.some((round) => round.status === 'running') ?? false
  const completed = latest.filter(
    (attempt) => attempt.status !== 'queued' && attempt.status !== 'running'
  ).length
  return (
    <div className='space-y-6'>
      <div className='bg-card rounded-xl border p-5'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h2 className='flex items-center gap-2 text-lg font-semibold'>
              <FlaskConical className='text-primary size-5' />
              {t('Comparison lab')}
            </h2>
            <p className='text-muted-foreground mt-1 max-w-3xl text-sm'>
              {t(
                'Runs on the server after you leave. Configurations and the latest 20 rounds are private to your account.'
              )}
            </p>
          </div>
          <Badge variant='outline'>{t('Default timeout: 20 minutes')}</Badge>
        </div>
        <p className='text-muted-foreground mt-3 text-xs'>
          {t(
            'Use public HTTPS endpoints. Keys are sent to the server, encrypted, and removed after the round unless you choose to save them.'
          )}
        </p>
      </div>
      <form
        onSubmit={form.handleSubmit((input) =>
          mutation.mutate({ kind: 'start', input })
        )}
        className='space-y-4'
      >
        <fieldset disabled={mutation.isPending} className='space-y-4'>
          <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
            {groups.fields.map((field, index) => (
              <ComparisonGroupEditor
                key={field.id}
                form={form}
                index={index}
                removable={groups.fields.length > 1}
                onRemove={() => groups.remove(index)}
              />
            ))}
          </div>
          <Button
            type='button'
            variant='outline'
            disabled={groups.fields.length >= 10}
            onClick={() =>
              groups.append({
                ...newTestGroup(),
                name: t('Group {{number}}', {
                  number: groups.fields.length + 1,
                }),
              })
            }
          >
            <Plus />
            {t('Add test group')}
          </Button>
          <div className='bg-card grid gap-4 rounded-xl border p-4 md:grid-cols-[1fr_180px]'>
            <div className='space-y-2'>
              <Label htmlFor='comparison-prompt'>{t('Shared prompt')}</Label>
              <Textarea
                id='comparison-prompt'
                className='min-h-36'
                {...form.register('prompt')}
              />
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={() =>
                  form.setValue('prompt', prompt.data?.prompt ?? '')
                }
              >
                {t('Use wall prompt')}
              </Button>
            </div>
            <div className='space-y-4'>
              <div className='space-y-2'>
                <Label htmlFor='comparison-concurrency'>
                  {t('Concurrent groups')}
                </Label>
                <Input
                  id='comparison-concurrency'
                  type='number'
                  min={1}
                  max={10}
                  {...form.register('concurrency', { valueAsNumber: true })}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='comparison-timeout'>
                  {t('Timeout (minutes)')}
                </Label>
                <Input
                  id='comparison-timeout'
                  type='number'
                  min={1}
                  max={60}
                  value={form.watch('timeout_seconds') / 60}
                  onChange={(event) =>
                    form.setValue(
                      'timeout_seconds',
                      Number(event.target.value) * 60,
                      { shouldValidate: true }
                    )
                  }
                />
              </div>
            </div>
          </div>
          {(form.formState.errors.prompt ||
            form.formState.errors.concurrency ||
            form.formState.errors.timeout_seconds) && (
            <p role='alert' className='text-destructive text-sm'>
              {t(
                'Enter a prompt, 1–10 concurrent groups and a 1–60 minute timeout.'
              )}
            </p>
          )}
          <div className='flex flex-wrap items-center gap-2'>
            <Button type='submit' disabled={active}>
              <Play />
              {t('Start comparison')}
            </Button>
            <Button
              type='button'
              variant='outline'
              onClick={() =>
                void form.handleSubmit((input) =>
                  mutation.mutate({ kind: 'save', input })
                )()
              }
            >
              <Save />
              {t('Save configuration')}
            </Button>
            {active && (
              <span role='status' className='text-muted-foreground text-xs'>
                {t('A comparison is running in the background')}
              </span>
            )}
          </div>
        </fieldset>
      </form>
      <section className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <h2 className='text-lg font-semibold'>{t('Comparison results')}</h2>
          <div className='flex flex-wrap gap-2'>
            <NativeSelect
              aria-label={t('Comparison history')}
              value={roundID ?? ''}
              onChange={(event) => setSelected(Number(event.target.value))}
            >
              <NativeSelectOption value='' disabled>
                {t('Recent 20 rounds')}
              </NativeSelectOption>
              {history.data?.map((round) => (
                <NativeSelectOption key={round.id} value={round.id}>
                  #{round.id} · {formatTimestampToDate(round.created_at)}
                  {round.status === 'running' ? ` · ${t('Running')}` : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {detail.data?.round.status === 'running' && (
              <Button
                variant='outline'
                disabled={mutation.isPending}
                onClick={() => setStopAll(true)}
              >
                <Square />
                {t('Stop all')}
              </Button>
            )}
          </div>
        </div>
        {history.isError && (
          <ErrorState
            title={t('Failed to load history')}
            onRetry={() => void history.refetch()}
          />
        )}
        {detail.isError && (
          <ErrorState
            title={t('Failed to load history')}
            onRetry={() => void detail.refetch()}
          />
        )}
        {!roundID && !history.isLoading && (
          <EmptyState
            title={t('No comparisons yet')}
            description={t(
              'Add groups and start a comparison to see live results here.'
            )}
          />
        )}
        {detail.data && (
          <>
            <div className='bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg p-3 text-sm'>
              <span aria-live='polite'>
                {t('{{completed}} / {{total}} groups completed', {
                  completed,
                  total: latest.length,
                })}
              </span>
              <Button
                variant='ghost'
                size='sm'
                disabled={mutation.isPending}
                onClick={() => {
                  form.reset({
                    prompt: detail.data.round.prompt,
                    concurrency: detail.data.round.concurrency,
                    timeout_seconds: detail.data.round.timeout_seconds,
                    groups: latest.map((item) => {
                      const saved = profiles.data?.find(
                        (group) =>
                          group.base_url === item.base_url &&
                          group.protocol === item.protocol &&
                          group.name === item.name
                      )
                      return {
                        ...newTestGroup(),
                        id: saved?.id ?? 0,
                        name: item.name,
                        base_url: item.base_url,
                        model: item.model,
                        protocol: item.protocol,
                        effort: item.effort,
                        max_output_tokens:
                          item.max_output_tokens ??
                          (item.protocol === 'anthropic' ? 8192 : 32768),
                        remember_key: saved?.remember_key ?? false,
                        has_saved_key: saved?.has_saved_key ?? false,
                      }
                    }),
                  })
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
              >
                {t('Load this round into the form')}
              </Button>
            </div>
            <details className='rounded-lg border p-3 text-sm'>
              <summary className='cursor-pointer'>
                {t('Prompt snapshot')}
              </summary>
              <pre className='mt-3 max-h-48 overflow-auto text-xs whitespace-pre-wrap'>
                {detail.data.round.prompt}
              </pre>
            </details>
            <div className='overflow-x-auto pb-3'>
              <div className='grid auto-cols-[minmax(280px,1fr)] grid-flow-col items-start gap-4'>
                {latest.map((item) => (
                  <ComparisonResult
                    prompt={detail.data.round.prompt}
                    latest={item}
                    key={`${roundID}-${item.group_index}`}
                    attempts={detail.data.attempts.filter(
                      (attempt) => attempt.group_index === item.group_index
                    )}
                    busy={mutation.isPending}
                    onStop={(attemptID) =>
                      mutation.mutate({ kind: 'stop', attemptID })
                    }
                    onRetry={(attempt) => {
                      setRetry(attempt)
                      setRetryKey('')
                    }}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </section>
      <LegacySelfTests />
      <Dialog
        open={!!retry}
        onOpenChange={(open) => {
          if (!open) {
            setRetry(null)
            setRetryKey('')
          }
        }}
        title={t('Retry group')}
        description={t(
          'A new attempt is added to this round. Enter the key again if it was not saved.'
        )}
        footer={
          <Button
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ kind: 'retry', attemptID: retry?.id })
            }
          >
            {t('Retry')}
          </Button>
        }
      >
        <Label htmlFor='comparison-retry-key'>{t('API key')}</Label>
        <PasswordInput
          id='comparison-retry-key'
          autoComplete='off'
          value={retryKey}
          onChange={(event) => setRetryKey(event.target.value)}
        />
      </Dialog>
      <ConfirmDialog
        open={stopAll}
        onOpenChange={setStopAll}
        title={t('Stop all groups?')}
        desc={t(
          'Completed results are kept. Queued and running groups will be cancelled.'
        )}
        confirmText={t('Stop all')}
        isLoading={mutation.isPending}
        handleConfirm={() => mutation.mutate({ kind: 'stop' })}
      />
    </div>
  )
}
