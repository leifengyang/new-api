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
import axios, { type AxiosRequestConfig } from 'axios'
import { t } from 'i18next'

import { clearAuthentication, getFreshAuthHeaders } from '@/lib/auth-session'
import { api } from '@/lib/http-client'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getCanvasErrorMessage } from './lib/errors'
import type {
  CanvasBootstrap,
  CanvasIdentity,
  CanvasStorageRequest,
  CanvasStorageResponse,
} from './types'

export function isCanvasSessionCurrent(identity: CanvasIdentity): boolean {
  const auth = useAuthStore.getState().auth
  return (
    auth.user?.id === identity.userId &&
    auth.session?.sid === identity.sessionId &&
    auth.session.expires_at > Math.floor(Date.now() / 1000)
  )
}

/** Bind both dispatch and delivery to the account that opened the workbench. */
async function canvasSessionRequest<T>(
  identity: CanvasIdentity,
  config: AxiosRequestConfig,
  signal: AbortSignal
) {
  if (!isCanvasSessionCurrent(identity)) throw new Error(t('Session expired!'))
  const controller = new AbortController()
  const unsubscribe = useAuthStore.subscribe(() => {
    if (!isCanvasSessionCurrent(identity)) controller.abort()
  })
  try {
    const headers = await getFreshAuthHeaders()
    const adapter = axios.getAdapter(api.defaults.adapter)
    const response = await api.request<T>({
      ...config,
      headers: { ...headers, ...config.headers },
      signal: AbortSignal.any([signal, controller.signal]),
      skipAuthRefresh: true,
      skipErrorHandler: true,
      // The shared client's interceptor reads the current account. Check again
      // after all interceptors, immediately before the HTTP adapter dispatches.
      adapter: (request) => {
        if (!isCanvasSessionCurrent(identity)) {
          throw new axios.CanceledError('Canvas session changed')
        }
        return adapter(request)
      },
    })
    if (!isCanvasSessionCurrent(identity) || signal.aborted) {
      throw new axios.CanceledError('Canvas session changed')
    }
    if (response.status === 401) {
      clearAuthentication(false)
      throw new Error(t('Session expired!'))
    }
    return response
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      isCanvasSessionCurrent(identity)
    ) {
      clearAuthentication(false)
    }
    throw error
  } finally {
    unsubscribe()
  }
}

export async function bootstrapCanvas(
  identity: CanvasIdentity,
  signal: AbortSignal,
  resetToken = false
): Promise<CanvasBootstrap> {
  const response = await canvasSessionRequest<{
    success: boolean
    message?: string
    data?: CanvasBootstrap
  }>(
    identity,
    {
      method: 'POST',
      url: resetToken ? '/api/canvas/reset-token' : '/api/canvas/bootstrap',
    },
    signal
  )
  const data = requireServerSuccess(response.data).data
  if (
    !data ||
    data.user_id !== identity.userId ||
    !Number.isInteger(data.token_id) ||
    typeof data.api_key !== 'string' ||
    !data.api_key.startsWith('sk-') ||
    data.base_url !== '/v1'
  ) {
    throw new Error(t('Unable to open canvas'))
  }
  return data
}

export async function requestCanvasStorage(
  identity: CanvasIdentity,
  request: CanvasStorageRequest,
  signal: AbortSignal
): Promise<CanvasStorageResponse> {
  const headers: Record<string, string> = {
    'Content-Type': request.contentType || 'application/octet-stream',
  }
  if (request.expectedHash === 'absent') {
    headers['If-None-Match'] = '*'
  } else if (request.expectedHash !== undefined) {
    headers['If-Match'] = `"${request.expectedHash}"`
  }
  const response = await canvasSessionRequest<ArrayBuffer>(
    identity,
    {
      url: request.path,
      method: request.method,
      data: request.body,
      headers,
      responseType: 'arraybuffer',
      // Preserve HTTP errors for the storage adapter (notably missing keys).
      validateStatus: () => true,
    },
    signal
  )
  const contentType = String(
    response.headers['content-type'] || 'application/octet-stream'
  )
  let body = response.data
  if (
    response.status >= 400 &&
    contentType.toLowerCase().startsWith('application/json') &&
    body.byteLength <= 64 * 1024
  ) {
    try {
      const error: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(body)
      )
      if (
        error &&
        typeof error === 'object' &&
        !Array.isArray(error) &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('CANVAS_')
      ) {
        body = new TextEncoder().encode(
          JSON.stringify({
            ...error,
            message: getCanvasErrorMessage(error),
          })
        ).buffer
      }
    } catch {
      // Preserve non-JSON/proxy errors without guessing or exposing request data.
    }
  }
  return {
    status: response.status,
    body,
    contentType,
  }
}
