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
import { describe, expect, it, vi } from 'vitest'

import { createCanvasBridge, parseCanvasRequest } from '../lib/bridge'

const bootstrap = {
  user_id: 1,
  token_id: 2,
  api_key: 'sk-test',
  base_url: '/v1',
}
const request = {
  type: 'newapi-canvas-request',
  id: 'request-1',
  operation: 'storage',
  method: 'GET',
  path: '/api/canvas/storage/projects/project-1',
}

describe('canvas bridge request validation', () => {
  it.each(['absent', 'a'.repeat(64)])(
    'accepts a chat PUT condition %s',
    (expectedHash) => {
      const message = {
        ...request,
        method: 'PUT',
        path: '/api/canvas/storage/chats/thread-1',
        expectedHash,
      }
      expect(parseCanvasRequest(message)).toEqual(message)
    }
  )

  it('rejects malformed conditions and conditions outside a single chat PUT', () => {
    const message = {
      ...request,
      method: 'PUT',
      path: '/api/canvas/storage/chats/thread-1',
      expectedHash: 'absent',
    }
    for (const expectedHash of [
      null,
      {},
      '',
      'a'.repeat(63),
      'A'.repeat(64),
      '"\r\nAuthorization: injected',
    ]) {
      expect(parseCanvasRequest({ ...message, expectedHash })).toBeNull()
    }
    for (const method of ['GET', 'DELETE']) {
      expect(parseCanvasRequest({ ...message, method })).toBeNull()
    }
    for (const path of [
      '/api/canvas/storage/chats',
      '/api/canvas/storage/projects/project-1',
    ]) {
      expect(parseCanvasRequest({ ...message, path })).toBeNull()
    }
  })

  it.each([
    'https://attacker.test/api/canvas/storage/projects/id',
    '//attacker.test/api/canvas/storage/projects/id',
    '/api/user/self',
    '/api/canvas/storage/projects/../bootstrap',
    '/api/canvas/storage/projects/%2e%2e',
    '/api/canvas/storage/projects/id?redirect=/api/user/self',
    '/api/canvas/storage/projects/id#fragment',
    '/api/canvas/storage/channels/key',
    '/api/canvas/storage/projects/%00',
    '/api/canvas/storage/projects/%invalid',
  ])('rejects %s before attaching authentication', (path) => {
    expect(parseCanvasRequest({ ...request, path })).toBeNull()
  })

  it('accepts an encoded unicode record key including slash as data', () => {
    const path = `/api/canvas/storage/state/${encodeURIComponent('画布/偏好')}`
    expect(parseCanvasRequest({ ...request, path })?.operation).toBe('storage')
  })

  it('rejects oversized bodies, GET bodies, and header injection', () => {
    expect(
      parseCanvasRequest({
        ...request,
        method: 'PUT',
        body: new ArrayBuffer(32 * 1024 * 1024 + 1),
      })
    ).toBeNull()
    expect(
      parseCanvasRequest({ ...request, body: new ArrayBuffer(1) })
    ).toBeNull()
    expect(
      parseCanvasRequest({
        ...request,
        method: 'PUT',
        contentType: 'text/plain\r\nAuthorization: injected',
      })
    ).toBeNull()
  })
})

describe('canvas bridge account confinement', () => {
  it('shows a translated startup failure instead of the internal error code', async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window
    const onError = vi.fn()
    const bridge = createCanvasBridge({
      frame,
      origin: window.location.origin,
      bootstrap,
      storage: vi.fn(),
      isCurrent: () => true,
      onReady: vi.fn(),
      onError,
    })
    await bridge.handle(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame,
        data: { type: 'newapi-canvas-error', message: 'CANVAS_STARTUP_FAILED' },
      })
    )
    expect(onError).toHaveBeenCalledWith('Unable to open canvas')
    bridge.dispose()
  })

  it('ignores a matching message from another origin or another window', async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window
    const storage = vi.fn()
    const onReady = vi.fn()
    const bridge = createCanvasBridge({
      frame,
      origin: window.location.origin,
      bootstrap,
      storage,
      isCurrent: () => true,
      onReady,
      onError: vi.fn(),
    })
    await bridge.handle(
      new MessageEvent('message', {
        origin: 'https://attacker.test',
        source: frame,
        data: request,
      })
    )
    await bridge.handle(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window,
        data: request,
      })
    )
    expect(storage).not.toHaveBeenCalled()
    expect(frame.postMessage).not.toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('delivers bootstrap only to the expected frame with an exact target origin', async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window
    const bridge = createCanvasBridge({
      frame,
      origin: window.location.origin,
      bootstrap,
      storage: vi.fn(),
      isCurrent: () => true,
      onReady: vi.fn(),
      onError: vi.fn(),
    })
    await bridge.handle(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame,
        data: { ...request, operation: 'bootstrap' },
      })
    )
    expect(frame.postMessage).toHaveBeenCalledWith(
      {
        type: 'newapi-canvas-response',
        id: request.id,
        ok: true,
        data: bootstrap,
      },
      window.location.origin
    )
    bridge.dispose()
  })

  it('drops an in-flight response after the account changes', async () => {
    let current = true
    let finish!: (result: {
      status: number
      body: ArrayBuffer
      contentType: string
    }) => void
    const frame = { postMessage: vi.fn() } as unknown as Window
    const storage = vi.fn(
      () =>
        new Promise<{ status: number; body: ArrayBuffer; contentType: string }>(
          (resolve) => {
            finish = resolve
          }
        )
    )
    const bridge = createCanvasBridge({
      frame,
      origin: window.location.origin,
      bootstrap,
      storage,
      isCurrent: () => current,
      onReady: vi.fn(),
      onError: vi.fn(),
    })
    const pending = bridge.handle(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame,
        data: request,
      })
    )
    current = false
    finish({
      status: 200,
      body: new ArrayBuffer(0),
      contentType: 'application/json',
    })
    await pending
    expect(frame.postMessage).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('aborts pending storage and refuses bootstrap after disposal', async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window
    let signal: AbortSignal | undefined
    const storage = vi.fn(async (_request, abortSignal) => {
      signal = abortSignal
      return {
        status: 200,
        body: new ArrayBuffer(0),
        contentType: 'application/json',
      }
    })
    const bridge = createCanvasBridge({
      frame,
      origin: window.location.origin,
      bootstrap,
      storage,
      isCurrent: () => true,
      onReady: vi.fn(),
      onError: vi.fn(),
    })
    const pending = bridge.handle(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame,
        data: request,
      })
    )
    bridge.dispose()
    await pending
    await bridge.handle(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame,
        data: { ...request, operation: 'bootstrap' },
      })
    )
    expect(signal?.aborted).toBe(true)
    expect(frame.postMessage).not.toHaveBeenCalled()
  })
})
