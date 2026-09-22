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
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { useSystemConfigStore } from '@/stores/system-config-store'

import { AuthLayout } from '../auth-layout'

const LEDE = 'Route every model request through one endpoint.'

function renderLayout(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({ component: () => ui })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/sign-in'] }),
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

function setSystemConfig(loading: boolean) {
  useSystemConfigStore.setState({
    config: {
      ...useSystemConfigStore.getState().config,
      systemName: 'Acme Gateway',
      logo: 'data:image/png;base64,iVBORw0KGgo=',
    },
    loading,
  })
}

afterEach(() => {
  localStorage.clear()
})

describe('Auth layout', () => {
  it('names the deployment in the panel heading and shows the lede a screen provides', async () => {
    setSystemConfig(false)

    renderLayout(
      <AuthLayout lede={LEDE}>
        <p>form</p>
      </AuthLayout>
    )

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Acme Gateway'
    )
    expect(screen.getByText(LEDE)).toBeInTheDocument()
  })

  it('renders no lede paragraph for the screens that provide none', async () => {
    setSystemConfig(false)

    const { container } = renderLayout(
      <AuthLayout>
        <p>form</p>
      </AuthLayout>
    )

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Acme Gateway'
    )
    const panel = container.querySelector('aside')
    expect(panel).not.toBeNull()
    expect(panel?.querySelectorAll('p')).toHaveLength(0)
  })

  it('keeps the decorative gate motif out of the accessible tree', async () => {
    setSystemConfig(false)

    const { container } = renderLayout(
      <AuthLayout lede={LEDE}>
        <p>form</p>
      </AuthLayout>
    )

    await screen.findByRole('heading', { level: 1 })

    const motif = container.querySelector('svg')
    expect(motif).not.toBeNull()
    expect(motif?.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('withholds the deployment name and logo while the system config is loading', async () => {
    setSystemConfig(true)

    renderLayout(
      <AuthLayout lede={LEDE}>
        <p>form</p>
      </AuthLayout>
    )

    expect(await screen.findByText(LEDE)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.queryByAltText('Logo')).toBeNull()
  })

  it('renders the form area as the page main region', async () => {
    setSystemConfig(false)

    renderLayout(
      <AuthLayout lede={LEDE}>
        <p>form</p>
      </AuthLayout>
    )

    await waitFor(() =>
      expect(screen.getByRole('main')).toHaveTextContent('form')
    )
  })
})
