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
import { Play, ShieldAlert, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { PasswordInput } from '@/components/password-input'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'

import { useDegradationWatchPrompt } from '../hooks/use-degradation-watch'
import {
  describeSelfTestFailure,
  REASONING_EFFORTS,
  runSelfTest,
  type SelfTestResult,
} from '../lib/self-test'
import {
  loadSelfTestHistory,
  loadSelfTestSettings,
  removeSelfTestResult,
  saveSelfTestResult,
  saveSelfTestSettings,
} from '../lib/storage'
import { ArtworkPlayerDialog } from './artwork-player-dialog'
import { RecordCard, RecordMeta } from './record-card'

/** Adapts a local result to the card the wall uses, so both look the same. */
function toCardRecord(result: SelfTestResult, failureText: string) {
  return {
    id: 0,
    model_name: result.model,
    reasoning_effort: result.reasoningEffort,
    success: result.success,
    failure_reason: failureText,
    elapsed_ms: result.elapsedMs,
    prompt_tokens: 0,
    completion_tokens: result.completionTokens,
    reasoning_tokens: result.reasoningTokens,
    hidden: false,
    created_at: result.createdAt,
  }
}

export function SelfTestPanel() {
  const { t } = useTranslation()
  const prompt = useDegradationWatchPrompt()
  const stored = useRef(loadSelfTestSettings()).current

  const [baseUrl, setBaseUrl] = useState(stored.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(stored.apiKey ?? '')
  const [rememberKey, setRememberKey] = useState(Boolean(stored.rememberKey))
  const [model, setModel] = useState(stored.model ?? '')
  const [effort, setEffort] = useState(stored.reasoningEffort ?? 'medium')
  const [history, setHistory] = useState(loadSelfTestHistory)
  const [running, setRunning] = useState(false)
  const [lastFailure, setLastFailure] = useState<SelfTestResult | null>(null)
  const [openResult, setOpenResult] = useState<SelfTestResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // The server's model is the default until the user picks their own.
  useEffect(() => {
    if (model === '' && prompt.data?.model) setModel(prompt.data.model)
  }, [model, prompt.data?.model])

  useEffect(() => () => abortRef.current?.abort(), [])

  if (prompt.isLoading) return <LoadingState />
  if (prompt.isError || !prompt.data) {
    return (
      <ErrorState
        title={t('Failed to load the prompt')}
        onRetry={() => void prompt.refetch()}
      />
    )
  }

  const promptText = prompt.data.prompt
  const canRun =
    !running && baseUrl.trim() !== '' && apiKey.trim() !== '' && model !== ''

  async function start() {
    saveSelfTestSettings({
      baseUrl,
      apiKey,
      rememberKey,
      model,
      reasoningEffort: effort,
    })
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setLastFailure(null)
    try {
      const result = await runSelfTest(
        { baseUrl, apiKey, model, reasoningEffort: effort, prompt: promptText },
        controller.signal
      )
      if (result.failure === 'aborted') return
      setHistory(saveSelfTestResult(result))
      if (!result.success) setLastFailure(result)
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  return (
    <div className='flex flex-col gap-6'>
      <Alert>
        <ShieldAlert />
        <AlertTitle>{t('Runs in your browser')}</AlertTitle>
        <AlertDescription>
          {t(
            'The request goes straight from this page to the base URL below with your key; neither is sent to this site, and results are kept only in this browser. The endpoint must allow cross-origin requests (CORS) from this page, otherwise the browser blocks it.'
          )}
        </AlertDescription>
      </Alert>

      <div className='grid gap-4 md:grid-cols-2'>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='dw-base-url'>{t('Base URL')}</Label>
          <Input
            id='dw-base-url'
            placeholder='https://api.example.com/v1'
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoComplete='off'
          />
        </div>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='dw-api-key'>{t('API key')}</Label>
          <PasswordInput
            id='dw-api-key'
            placeholder='sk-...'
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete='off'
          />
          <label className='text-muted-foreground flex items-center gap-2 text-xs'>
            <Checkbox
              checked={rememberKey}
              onCheckedChange={(checked) => setRememberKey(checked === true)}
            />
            {t('Remember the key in this browser')}
          </label>
        </div>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='dw-model'>{t('Model')}</Label>
          <Input
            id='dw-model'
            value={model}
            onChange={(event) => setModel(event.target.value)}
            autoComplete='off'
          />
        </div>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='dw-effort'>{t('Reasoning effort')}</Label>
          <NativeSelect
            id='dw-effort'
            className='w-full'
            value={effort}
            onChange={(event) => setEffort(event.target.value)}
          >
            {REASONING_EFFORTS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value === '' ? t('Not sent') : value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className='flex flex-col gap-2'>
        <Label htmlFor='dw-prompt'>{t('Prompt (same as the wall)')}</Label>
        <Textarea
          id='dw-prompt'
          readOnly
          value={promptText}
          className='min-h-32 text-xs'
        />
      </div>

      <div className='flex items-center gap-2'>
        <Button disabled={!canRun} onClick={() => void start()}>
          <Play />
          {running ? t('Drawing…') : t('Start self-test')}
        </Button>
        {running && (
          <Button variant='outline' onClick={() => abortRef.current?.abort()}>
            <Square />
            {t('Stop')}
          </Button>
        )}
        {running && (
          <span className='text-muted-foreground text-sm'>
            {t('Animations usually take one to a few minutes.')}
          </span>
        )}
      </div>

      {lastFailure?.failure === 'network' && (
        <Alert variant='destructive'>
          <AlertTitle>{t('The browser blocked the request')}</AlertTitle>
          <AlertDescription>
            {t(
              'Either the base URL is unreachable, or the endpoint does not send CORS headers allowing this page. That is a setting on the endpoint, not something this page can work around; the wall above is tested server-side and is not affected.'
            )}
          </AlertDescription>
        </Alert>
      )}
      {lastFailure?.failure === 'http' && (
        <Alert variant='destructive'>
          <AlertTitle>{t('The endpoint returned an error')}</AlertTitle>
          <AlertDescription className='break-all'>
            {lastFailure.detail}
          </AlertDescription>
        </Alert>
      )}

      {history.length > 0 && (
        <div className='flex flex-col gap-3'>
          <div className='flex items-center justify-between'>
            <h2 className='text-lg font-semibold'>
              {t('Your recent self-tests')}
            </h2>
            <span className='text-muted-foreground text-xs'>
              {t('Stored in this browser only')}
            </span>
          </div>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'>
            {history.map((result) => (
              <SelfTestCard
                key={result.id}
                result={result}
                onOpen={setOpenResult}
                onRemove={(id) => setHistory(removeSelfTestResult(id))}
              />
            ))}
          </div>
        </div>
      )}

      {openResult && (
        <ArtworkPlayerDialog
          open
          onOpenChange={(open) => {
            if (!open) setOpenResult(null)
          }}
          title={t('Self-test')}
          html={openResult.html}
          failureReason={
            openResult.success
              ? undefined
              : t(describeSelfTestFailure(openResult))
          }
          meta={
            <RecordMeta
              modelName={openResult.model}
              reasoningEffort={openResult.reasoningEffort}
              createdAt={openResult.createdAt}
              elapsedMs={openResult.elapsedMs}
              reasoningTokens={openResult.reasoningTokens}
            />
          }
        />
      )}
    </div>
  )
}

interface SelfTestCardProps {
  result: SelfTestResult
  onOpen: (result: SelfTestResult) => void
  onRemove: (id: string) => void
}

function SelfTestCard(props: SelfTestCardProps) {
  const { t } = useTranslation()
  const failureText = t(describeSelfTestFailure(props.result))
  return (
    <div className='relative'>
      <RecordCard
        record={toCardRecord(props.result, failureText)}
        localHtml={props.result.html}
        onOpen={() => props.onOpen(props.result)}
      />
      <Button
        variant='secondary'
        size='icon-xs'
        className='absolute top-2 right-2'
        aria-label={t('Remove')}
        onClick={() => props.onRemove(props.result.id)}
      >
        <Trash2 />
      </Button>
    </div>
  )
}
