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
import { t } from 'i18next'

import { getServerErrorMessage } from '@/lib/server-error-message'

import type {
  CanvasBootstrap,
  CanvasRequest,
  CanvasStorageRequest,
  CanvasStorageResponse,
} from '../types'

const collections = new Set([
  'projects',
  'works',
  'state',
  'preferences',
  'images',
  'previews',
  'media',
  'imageRecords',
  'videoRecords',
  'audioRecords',
  'agentRecords',
  'chats',
  'pluginData',
])
const maxBodySize = 32 * 1024 * 1024

export function parseCanvasRequest(value: unknown): CanvasRequest | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (
    message.type !== 'newapi-canvas-request' ||
    typeof message.id !== 'string' ||
    !message.id ||
    message.id.length > 128
  ) {
    return null
  }
  if (message.operation === 'bootstrap') {
    return { type: message.type, id: message.id, operation: 'bootstrap' }
  }
  if (
    message.operation !== 'storage' ||
    typeof message.path !== 'string' ||
    !['GET', 'PUT', 'DELETE'].includes(String(message.method))
  ) {
    return null
  }
  // Decode each segment, rather than allowing URL normalization to turn a
  // storage path into another authenticated management endpoint.
  const parts = message.path.split('/')
  if (
    (parts.length !== 5 && parts.length !== 6) ||
    parts.slice(0, 4).join('/') !== '/api/canvas/storage' ||
    !collections.has(parts[4]) ||
    /[?#\\\s]/.test(message.path)
  ) {
    return null
  }
  if (parts.length === 6) {
    try {
      const key = decodeURIComponent(parts[5])
      if (
        !key ||
        key === '.' ||
        key === '..' ||
        key.includes('\0') ||
        new TextEncoder().encode(key).byteLength > 512
      ) {
        return null
      }
    } catch {
      return null
    }
  } else if (message.method === 'PUT') return null
  if (
    message.body !== undefined &&
    (!(message.body instanceof ArrayBuffer) ||
      message.body.byteLength > maxBodySize ||
      message.method !== 'PUT')
  ) {
    return null
  }
  if (
    message.contentType !== undefined &&
    (typeof message.contentType !== 'string' ||
      message.contentType.length > 128 ||
      /[\r\n]/.test(message.contentType))
  ) {
    return null
  }
  if (
    message.expectedHash !== undefined &&
    (message.method !== 'PUT' ||
      parts.length !== 6 ||
      parts[4] !== 'chats' ||
      typeof message.expectedHash !== 'string' ||
      (message.expectedHash !== 'absent' &&
        !/^[a-f0-9]{64}$/.test(message.expectedHash)))
  ) {
    return null
  }
  return message as CanvasStorageRequest
}

export interface CanvasBridgeOptions {
  frame: Window
  origin: string
  bootstrap: CanvasBootstrap
  isCurrent: () => boolean
  storage: (
    request: CanvasStorageRequest,
    signal: AbortSignal
  ) => Promise<CanvasStorageResponse>
  onReady: () => void
  onError: (message: string) => void
}

/** A capability limited to canvas storage, never an arbitrary authenticated proxy. */
export function createCanvasBridge(options: CanvasBridgeOptions) {
  const controller = new AbortController()
  const pending = new Set<string>()
  let active = true
  const current = () =>
    active && !controller.signal.aborted && options.isCurrent()
  const handle = async (event: MessageEvent) => {
    if (
      event.origin !== options.origin ||
      event.source !== options.frame ||
      !current()
    ) {
      return
    }
    if (event.data?.type === 'newapi-canvas-ready') {
      options.onReady()
      return
    }
    if (event.data?.type === 'newapi-canvas-error') {
      if (event.data.message === 'CANVAS_STARTUP_FAILED') {
        options.onError(t('Unable to open canvas'))
        return
      }
      options.onError(
        getServerErrorMessage(
          { message: event.data.message },
          t('Unable to open canvas')
        )
      )
      return
    }
    const request = parseCanvasRequest(event.data)
    if (!request || pending.has(request.id)) return
    pending.add(request.id)
    try {
      const data =
        request.operation === 'bootstrap'
          ? options.bootstrap
          : await options.storage(request, controller.signal)
      if (!current()) return
      options.frame.postMessage(
        { type: 'newapi-canvas-response', id: request.id, ok: true, data },
        options.origin
      )
    } catch (error) {
      if (!current()) return
      options.frame.postMessage(
        {
          type: 'newapi-canvas-response',
          id: request.id,
          ok: false,
          error: getServerErrorMessage(error, t('Request failed')),
        },
        options.origin
      )
    } finally {
      pending.delete(request.id)
    }
  }
  return {
    handle,
    dispose() {
      active = false
      controller.abort()
      pending.clear()
    },
  }
}
