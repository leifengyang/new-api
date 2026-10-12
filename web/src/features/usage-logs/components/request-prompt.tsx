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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

type RequestPrompt = {
  status: string
  text?: string
  attachments?: string
  truncated?: boolean
}

function RequestPromptContent(props: { requestId?: string }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['request-prompt', props.requestId],
    queryFn: async ({ signal }) => {
      const response = await api.get('/api/log/request-prompt', {
        params: { request_id: props.requestId },
        signal,
      })
      requireServerSuccess(response.data)
      return response.data.data as RequestPrompt
    },
    enabled: Boolean(props.requestId),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  if (props.requestId && query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  const prompt = query.data
  if (!prompt || prompt.status === 'unavailable') {
    return (
      <p className='text-muted-foreground text-sm'>
        {t(
          'No saved prompt. It may predate capture, have expired after 7 days, or could not be stored.'
        )}
      </p>
    )
  }
  if (prompt.status === 'disabled') {
    return (
      <p className='text-muted-foreground text-sm'>
        {t('Prompt capture was disabled for this request.')}
      </p>
    )
  }
  if (prompt.status !== 'captured') {
    return (
      <p className='text-muted-foreground text-sm'>
        {t('No readable user message was found in this request.')}
      </p>
    )
  }
  const attachmentLabels: Record<string, string> = {
    image: t('Contains image'),
    file: t('Contains file'),
    audio: t('Contains audio'),
    video: t('Contains video'),
  }
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        {prompt.truncated && (
          <Badge variant='outline'>
            {t('Truncated: beginning and end retained (128 KB limit)')}
          </Badge>
        )}
        {prompt.attachments
          ?.split(',')
          .filter(Boolean)
          .map((kind) => (
            <Badge key={kind} variant='secondary'>
              {attachmentLabels[kind]}
            </Badge>
          ))}
        {prompt.text && (
          <CopyButton value={prompt.text} size='sm' variant='outline'>
            {t('Copy saved prompt')}
          </CopyButton>
        )}
      </div>
      {prompt.text ? (
        <pre className='bg-muted/40 max-h-[55vh] overflow-auto rounded-lg border p-4 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap'>
          {prompt.text}
        </pre>
      ) : (
        <p className='text-muted-foreground text-sm'>
          {t('Attachments only; attachment content and links are not stored.')}
        </p>
      )}
    </div>
  )
}

export function RequestPromptButton(props: {
  requestId?: string
  isRoot: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!props.isRoot) return null
  return (
    <>
      <Button
        size='sm'
        variant='ghost'
        className='h-6 gap-1 px-1.5 text-xs text-sky-600 dark:text-sky-400'
        onClick={() => setOpen(true)}
      >
        <MessageSquareText className='size-3.5' />
        {t('View user prompt')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('User prompt')}
        description={t(
          'Last original user message only. Visible to the super administrator and retained for 7 days.'
        )}
      >
        {open && <RequestPromptContent requestId={props.requestId} />}
      </Dialog>
    </>
  )
}

export function RequestPromptCaptureSwitch() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const queryKey = ['request-prompt-capture']
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await api.get('/api/log/prompt-capture')
      requireServerSuccess(response.data)
      return response.data.data as { enabled: boolean }
    },
  })
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await api.put('/api/log/prompt-capture', { enabled })
      requireServerSuccess(response.data)
      return response.data.data as { enabled: boolean }
    },
    onSuccess: (data) => {
      client.setQueryData(queryKey, data)
    },
  })
  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5'>
      <Switch
        id='request-prompt-capture'
        checked={query.data?.enabled ?? false}
        disabled={!query.data || mutation.isPending}
        onCheckedChange={(enabled) => mutation.mutate(enabled)}
      />
      <Label htmlFor='request-prompt-capture' className='text-xs'>
        <MessageSquareText aria-hidden='true' className='size-4 sm:hidden' />
        <span className='sr-only sm:not-sr-only'>
          {t('Capture user prompts (7 days)')}
        </span>
      </Label>
      {query.isError && (
        <Button size='sm' variant='ghost' onClick={() => void query.refetch()}>
          {t('Retry')}
        </Button>
      )}
    </div>
  )
}
