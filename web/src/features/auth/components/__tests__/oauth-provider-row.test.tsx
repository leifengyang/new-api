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
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { SystemStatus } from '../../types'
import { OAuthProviders } from '../oauth-providers'

function renderProviders(status: Partial<SystemStatus>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({
    component: () => <OAuthProviders status={status as SystemStatus} />,
  })
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

afterEach(() => {
  localStorage.clear()
})

describe('OAuth provider row', () => {
  it('collapses several branded providers into icon buttons that keep their name', async () => {
    renderProviders({ github_oauth: true, discord_oauth: true })

    const github = await screen.findByRole('button', {
      name: 'Continue with GitHub',
    })
    const discord = screen.getByRole('button', {
      name: 'Continue with Discord',
    })

    expect(github).toHaveAttribute('aria-label', 'Continue with GitHub')
    expect(github).not.toHaveTextContent('Continue with')
    expect(discord).not.toHaveTextContent('Continue with')
    expect(github.parentElement).toBe(discord.parentElement)
  })

  it('keeps a lone branded provider labelled so the icon is never a guess', async () => {
    renderProviders({ github_oauth: true })

    const github = await screen.findByRole('button', {
      name: 'Continue with GitHub',
    })

    expect(github).toHaveTextContent('Continue with GitHub')
  })

  it('labels providers that ship no icon even when branded ones collapse', async () => {
    renderProviders({
      github_oauth: true,
      discord_oauth: true,
      oidc_enabled: true,
      oidc_display_name: 'Staff SSO',
    })

    const sso = await screen.findByRole('button', {
      name: 'Continue with Staff SSO',
    })
    const github = screen.getByRole('button', {
      name: 'Continue with GitHub',
    })

    expect(sso).toHaveTextContent('Continue with Staff SSO')
    expect(github).not.toHaveTextContent('Continue with')
    expect(sso.parentElement).not.toBe(github.parentElement)
  })

  it('renders nothing when the deployment enables no provider', () => {
    const { container } = renderProviders({})

    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
