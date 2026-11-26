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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { api } from '@/lib/http-client'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import { CanvasPage } from '../canvas-page'

const bundle: AuthBundle = {
  access_token: 'dashboard-access-token',
  token_type: 'Bearer',
  access_expires_at: 4_000_000_000,
  user: { id: 1, username: 'alice', role: 1 },
  session: {
    sid: 'session-alice',
    current: true,
    login_method: 'password',
    ip: '',
    user_agent: '',
    created_at: 1,
    last_active_at: 1,
    expires_at: 4_000_000_000,
  },
}
const data = { user_id: 1, token_id: 2, api_key: 'sk-test', base_url: '/v1' }
const originalAdapter = api.defaults.adapter
let client: QueryClient

beforeEach(() => {
  useAuthStore.getState().auth.setBundle(bundle)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['status'], {})
  api.defaults.adapter = async (config) => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
    data: { success: true, data },
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
})

async function renderCanvas(container?: HTMLElement) {
  const root = createRootRoute({ component: CanvasPage })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
    { container }
  )
}

describe('canvas workbench lifecycle', () => {
  it('escapes a dashboard containing block and restores the background after leaving', async () => {
    const dashboard = document.createElement('div')
    dashboard.id = 'root'
    dashboard.style.containerType = 'inline-size'
    dashboard.style.filter = 'blur(0px)'
    document.body.append(dashboard)
    try {
      const view = await renderCanvas(dashboard)
      const workbench = await screen.findByRole('region', {
        name: 'Infinite Canvas',
      })
      expect(workbench.parentElement).toBe(document.body)
      expect(dashboard.contains(workbench)).toBe(false)
      expect(dashboard.inert).toBe(true)
      expect(workbench).toHaveFocus()
      view.unmount()
      expect(dashboard.inert).toBe(false)
    } finally {
      dashboard.remove()
    }
  })

  it('shows loading until the trusted canvas reports readiness and provides a dashboard link', async () => {
    await renderCanvas()
    const frame = await screen.findByTitle<HTMLIFrameElement>('Infinite Canvas')
    expect(screen.getByRole('status')).toBeVisible()
    expect(frame).toHaveAttribute('src', '/canvas-app/index.html')
    expect(
      screen.getByRole('link', { name: 'Return to dashboard' })
    ).toHaveAttribute('href', '/dashboard')
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window,
        data: { type: 'newapi-canvas-ready' },
      })
    )
    expect(screen.getByRole('status')).toBeVisible()
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: 'newapi-canvas-ready' },
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    )
  })

  it('removes the workbench and its key cache when the user signs out', async () => {
    await renderCanvas()
    await screen.findByTitle('Infinite Canvas')
    act(() => useAuthStore.getState().auth.reset())
    expect(screen.queryByTitle('Infinite Canvas')).not.toBeInTheDocument()
    expect(await screen.findByText('Session expired!')).toBeVisible()
    await waitFor(() =>
      expect(
        client.getQueryData(['canvas-bootstrap', 1, 'session-alice'])
      ).toBeUndefined()
    )
  })

  it('shows a retry and key management when initialization is denied', async () => {
    api.defaults.adapter = async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      data: { success: false, code: 'CANVAS_TOKEN_DISABLED' },
    })
    await renderCanvas()
    expect(
      await screen.findByText(
        'Your canvas key is disabled. Enable it in API Keys to continue.'
      )
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'API Keys' })).toHaveAttribute(
      'href',
      '/keys'
    )
    expect(screen.queryByTitle('Infinite Canvas')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create replacement canvas key' })
    ).not.toBeInTheDocument()
  })

  it('requires confirmation before replacing a deleted key', async () => {
    const requests: string[] = []
    let deleted = true
    api.defaults.adapter = async (config) => {
      requests.push(config.url || '')
      if (config.url === '/api/canvas/reset-token') deleted = false
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: deleted
          ? { success: false, code: 'CANVAS_TOKEN_DELETED' }
          : { success: true, data },
      }
    }
    const user = userEvent.setup()
    await renderCanvas()
    await user.click(
      await screen.findByRole('button', {
        name: 'Create replacement canvas key',
      })
    )
    expect(requests).not.toContain('/api/canvas/reset-token')
    expect(screen.getByRole('alertdialog')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Create$/ }))
    await screen.findByTitle('Infinite Canvas')
    expect(
      requests.filter((path) => path === '/api/canvas/reset-token')
    ).toHaveLength(1)
  })

  it('shows a recoverable error when the trusted workbench fails to initialize', async () => {
    await renderCanvas()
    const frame = await screen.findByTitle<HTMLIFrameElement>('Infinite Canvas')
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {
          type: 'newapi-canvas-error',
          message: 'Model list is unavailable',
        },
      })
    )
    expect(await screen.findByText('Model list is unavailable')).toBeVisible()
    expect(screen.queryByTitle('Infinite Canvas')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTitle('Infinite Canvas')).toBeInTheDocument()
  })
})
