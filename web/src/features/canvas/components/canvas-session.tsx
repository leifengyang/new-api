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
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { getServerErrorSources } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  bootstrapCanvas,
  isCanvasSessionCurrent,
  requestCanvasStorage,
} from '../api'
import { createCanvasBridge } from '../lib/bridge'
import { getCanvasErrorMessage } from '../lib/errors'
import type { CanvasIdentity } from '../types'

export function CanvasSession(props: CanvasIdentity & { expiresAt: number }) {
  const { t } = useTranslation()
  const identity = useMemo(
    () => ({ userId: props.userId, sessionId: props.sessionId }),
    [props.userId, props.sessionId]
  )
  const iframe = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [frameError, setFrameError] = useState('')
  const [frameVersion, setFrameVersion] = useState(0)
  const [confirmReset, setConfirmReset] = useState(false)
  const [expired, setExpired] = useState(false)
  const bootstrap = useQuery({
    queryKey: ['canvas-bootstrap', identity.userId, identity.sessionId],
    queryFn: ({ signal }) => bootstrapCanvas(identity, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    meta: { errorToast: false },
  })
  const reset = useMutation({
    mutationFn: async () => {
      await bootstrapCanvas(identity, new AbortController().signal, true)
    },
    onSuccess: () => {
      setConfirmReset(false)
      void bootstrap.refetch()
    },
    gcTime: 0,
  })

  useEffect(() => {
    let timer: number
    const checkExpiration = () => {
      const remaining = props.expiresAt * 1000 - Date.now()
      if (remaining <= 0) {
        setExpired(true)
        return
      }
      timer = window.setTimeout(
        checkExpiration,
        Math.min(2_147_483_647, remaining)
      )
    }
    checkExpiration()
    return () => window.clearTimeout(timer)
  }, [props.expiresAt])

  useEffect(() => {
    const frame = iframe.current?.contentWindow
    if (
      !frame ||
      !bootstrap.data ||
      bootstrap.isError ||
      expired ||
      frameError
    ) {
      return
    }
    const bridge = createCanvasBridge({
      frame,
      origin: window.location.origin,
      bootstrap: bootstrap.data,
      isCurrent: () => isCanvasSessionCurrent(identity),
      storage: (request, signal) =>
        requestCanvasStorage(identity, request, signal),
      onReady: () => setReady(true),
      onError: (message) => setFrameError(message),
    })
    window.addEventListener('message', bridge.handle)
    const unsubscribe = useAuthStore.subscribe(() => {
      if (!isCanvasSessionCurrent(identity)) {
        bridge.dispose()
        // Immediately destroy the old account's in-memory workbench, without
        // waiting for React to commit a navigation or the next account render.
        if (iframe.current) iframe.current.src = 'about:blank'
      }
    })
    return () => {
      unsubscribe()
      window.removeEventListener('message', bridge.handle)
      bridge.dispose()
    }
  }, [
    bootstrap.data,
    bootstrap.isError,
    identity,
    frameVersion,
    expired,
    frameError,
  ])

  useEffect(() => {
    if (!bootstrap.data || ready || frameError || bootstrap.isError) return
    const timer = window.setTimeout(
      () => setFrameError(t('Canvas did not finish loading. Please retry.')),
      60_000
    )
    return () => window.clearTimeout(timer)
  }, [bootstrap.data, bootstrap.isError, ready, frameError, frameVersion, t])

  const retry = () => {
    setReady(false)
    setFrameError('')
    setFrameVersion((version) => version + 1)
    void bootstrap.refetch()
  }
  const tokenDeleted = getServerErrorSources(bootstrap.error).some(
    (source) => source.code === 'CANVAS_TOKEN_DELETED'
  )
  if (bootstrap.isError || frameError || expired) {
    return (
      <>
        <ErrorState
          title={t('Unable to open canvas')}
          description={
            expired
              ? t('Session expired!')
              : frameError || getCanvasErrorMessage(bootstrap.error)
          }
          onRetry={expired ? undefined : retry}
          action={
            <div className='flex flex-wrap justify-center gap-2'>
              <Button
                variant='outline'
                role='link'
                render={<Link to='/keys' />}
              >
                {t('API Keys')}
              </Button>
              {tokenDeleted && (
                <Button onClick={() => setConfirmReset(true)}>
                  {t('Create replacement canvas key')}
                </Button>
              )}
            </div>
          }
        />
        <ConfirmDialog
          open={confirmReset}
          onOpenChange={setConfirmReset}
          title={t('Create replacement canvas key')}
          desc={t(
            'Your previous canvas key was deleted. Create a new dedicated key to resume generation? Your saved work will be kept.'
          )}
          confirmText={t('Create')}
          isLoading={reset.isPending}
          handleConfirm={() => reset.mutate()}
        />
      </>
    )
  }
  if (!bootstrap.data) {
    return (
      <div role='status'>
        <LoadingState message={t('Preparing your canvas…')} />
      </div>
    )
  }
  return (
    <div className='relative min-h-0 flex-1'>
      {!ready && (
        <div
          role='status'
          className='bg-background absolute inset-0 z-10 flex items-center justify-center'
        >
          <LoadingState message={t('Preparing your canvas…')} />
        </div>
      )}
      {/* eslint-disable-next-line react/iframe-missing-sandbox -- Trusted, vendored same-origin application. It needs scripts and origin access; a sandbox allowing both provides no security boundary. The integration disables untrusted plugins/scripts and restricts its authenticated bridge. */}
      <iframe
        key={frameVersion}
        ref={iframe}
        src='/canvas-app/index.html'
        title={t('Infinite Canvas')}
        className='h-full w-full border-0'
        onError={() => setFrameError(t('Unable to open canvas'))}
        referrerPolicy='same-origin'
        allow='clipboard-write'
      />
    </div>
  )
}
