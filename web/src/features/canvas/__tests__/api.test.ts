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
import { AxiosHeaders, type AxiosAdapter, type AxiosResponse } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/http-client'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import { bootstrapCanvas, requestCanvasStorage } from '../api'

const owner = { userId: 1, sessionId: 'session-alice' }
const bundle: AuthBundle = {
  access_token: 'dashboard-access-token',
  token_type: 'Bearer',
  access_expires_at: 4_000_000_000,
  user: { id: 1, username: 'alice', role: 1 },
  session: {
    sid: owner.sessionId,
    current: true,
    login_method: 'password',
    ip: '',
    user_agent: '',
    created_at: 1,
    last_active_at: 1,
    expires_at: 4_000_000_000,
  },
}
const originalAdapter = api.defaults.adapter
beforeEach(() => useAuthStore.getState().auth.setBundle(bundle))
afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
})

describe('canvas authenticated requests', () => {
  it.each([
    ['absent', 'If-None-Match', '*', 'If-Match'],
    ['a'.repeat(64), 'If-Match', `"${'a'.repeat(64)}"`, 'If-None-Match'],
  ])(
    'sends the chat write condition %s and preserves conflicts',
    async (expectedHash, header, value, absentHeader) => {
      api.defaults.adapter = async (config) => {
        expect(config.headers.get(header)).toBe(value)
        expect(config.headers.has(absentHeader)).toBe(false)
        expect(config.headers.get('Authorization')).toBe(
          'Bearer dashboard-access-token'
        )
        return {
          status: 412,
          statusText: 'Precondition Failed',
          headers: { 'content-type': 'application/json' },
          config,
          data: new TextEncoder().encode(
            JSON.stringify({ success: false, code: 'CANVAS_STORAGE_CONFLICT' })
          ).buffer,
        }
      }
      const result = await requestCanvasStorage(
        owner,
        {
          type: 'newapi-canvas-request',
          id: 'chat-save',
          operation: 'storage',
          method: 'PUT',
          path: '/api/canvas/storage/chats/thread-1',
          body: new TextEncoder().encode('{}').buffer,
          contentType: 'application/json',
          expectedHash,
        },
        new AbortController().signal
      )
      expect(result.status).toBe(412)
      expect(JSON.parse(new TextDecoder().decode(result.body)).code).toBe(
        'CANVAS_STORAGE_CONFLICT'
      )
    }
  )

  it('translates a storage quota error while preserving its status and code', async () => {
    const error = {
      success: false,
      code: 'CANVAS_STORAGE_QUOTA_EXCEEDED',
      message: 'internal storage message',
    }
    api.defaults.adapter = async (config) => ({
      status: 413,
      statusText: 'Content Too Large',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      config,
      data: new TextEncoder().encode(JSON.stringify(error)).buffer,
    })
    const result = await requestCanvasStorage(
      owner,
      {
        type: 'newapi-canvas-request',
        id: 'save',
        operation: 'storage',
        method: 'PUT',
        path: '/api/canvas/storage/projects/example',
        body: new ArrayBuffer(0),
      },
      new AbortController().signal
    )
    expect(result.status).toBe(413)
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
      ...error,
      message:
        'Your canvas storage is full. Delete unused projects or assets, or contact your administrator.',
    })
  })

  it('uses the dashboard credential for initialization and validates its owner', async () => {
    api.defaults.adapter = vi.fn(async (config) => {
      expect(config.headers.get('Authorization')).toBe(
        'Bearer dashboard-access-token'
      )
      expect(config.url).toBe('/api/canvas/bootstrap')
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: {
          success: true,
          data: {
            user_id: 1,
            token_id: 2,
            api_key: 'sk-dedicated',
            base_url: '/v1',
          },
        },
      }
    }) as AxiosAdapter
    await expect(
      bootstrapCanvas(owner, new AbortController().signal)
    ).resolves.toMatchObject({ user_id: 1, api_key: 'sk-dedicated' })
  })

  it('does not dispatch an old canvas request under a newly signed-in account', async () => {
    let release!: () => void
    let intercepted!: () => void
    const reached = new Promise<void>((resolve) => {
      intercepted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const interceptor = api.interceptors.request.use(async (config) => {
      intercepted()
      await gate
      return config
    })
    const send = vi.fn()
    api.defaults.adapter = send
    try {
      const pending = bootstrapCanvas(owner, new AbortController().signal)
      const rejection = expect(pending).rejects.toThrow()
      await reached
      useAuthStore.getState().auth.setBundle({
        ...bundle,
        user: { id: 2, username: 'bob', role: 1 },
        session: { ...bundle.session, sid: 'session-bob' },
      })
      release()
      await rejection
      expect(send).not.toHaveBeenCalled()
    } finally {
      api.interceptors.request.eject(interceptor)
    }
  })

  it('drops a response and aborts its HTTP signal after sign out', async () => {
    let complete!: (response: AxiosResponse) => void
    let entered!: () => void
    let requestSignal: AbortSignal | undefined
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    api.defaults.adapter = (config) => {
      requestSignal = config.signal as AbortSignal
      entered()
      return new Promise((resolve) => {
        complete = resolve
      })
    }
    const pending = bootstrapCanvas(owner, new AbortController().signal)
    const rejection = expect(pending).rejects.toThrow()
    await reached
    useAuthStore.getState().auth.reset()
    complete({
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {
        success: true,
        data: { user_id: 1, token_id: 2, api_key: 'sk-old', base_url: '/v1' },
      },
    })
    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })

  it('preserves missing-key HTTP status and binary bodies for the adapter', async () => {
    const body = new Uint8Array([0, 255, 42]).buffer
    api.defaults.adapter = async (config) => ({
      status: 404,
      statusText: 'Not found',
      headers: { 'content-type': 'application/octet-stream' },
      config,
      data: body,
    })
    await expect(
      requestCanvasStorage(
        owner,
        {
          type: 'newapi-canvas-request',
          id: 'asset',
          operation: 'storage',
          method: 'GET',
          path: '/api/canvas/storage/images/missing',
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 404,
      body,
      contentType: 'application/octet-stream',
    })
  })

  it('clears the current session when storage reports an expired session', async () => {
    api.defaults.adapter = async (config) => ({
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
      data: new ArrayBuffer(0),
    })
    await expect(
      requestCanvasStorage(
        owner,
        {
          type: 'newapi-canvas-request',
          id: 'asset',
          operation: 'storage',
          method: 'GET',
          path: '/api/canvas/storage/images/missing',
        },
        new AbortController().signal
      )
    ).rejects.toThrow()
    expect(useAuthStore.getState().auth.user).toBeNull()
  })
})
