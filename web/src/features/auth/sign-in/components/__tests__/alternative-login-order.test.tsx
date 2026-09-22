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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { UserAuthForm } from '../user-auth-form'

type StatusOverrides = Record<string, unknown>

function mockStatus(overrides: StatusOverrides) {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/status') {
      return {
        data: {
          success: true,
          data: { password_login_enabled: true, ...overrides },
        },
      }
    }
    if (url === '/api/captcha') {
      return {
        data: {
          success: true,
          data: {
            captcha_id: 'challenge-1',
            image: 'data:image/png;base64,iVBORw0KGgo=',
            expires_in: 300,
          },
        },
      }
    }
    return { data: { success: true, data: {} } }
  })
}

function renderSignInForm() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({ component: () => <UserAuthForm /> })
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

beforeEach(() => {
  // Passkey support is a browser capability; jsdom exposes none by default.
  Object.defineProperty(window, 'PublicKeyCredential', {
    configurable: true,
    value: function PublicKeyCredential() {},
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'PublicKeyCredential')
  localStorage.clear()
})

describe('Sign-in alternative login order', () => {
  it('places the passkey button after the consent checkbox that gates it', async () => {
    mockStatus({ passkey_login: true, user_agreement_enabled: true })

    renderSignInForm()

    const consent = await screen.findByRole('checkbox')
    const passkey = screen.getByRole('button', { name: 'Sign in with Passkey' })
    expect(
      consent.compareDocumentPosition(passkey) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('places the password submit button before the alternative methods', async () => {
    mockStatus({ passkey_login: true })

    renderSignInForm()

    const submit = await screen.findByRole('button', { name: 'Sign in' })
    const passkey = screen.getByRole('button', { name: 'Sign in with Passkey' })
    expect(
      submit.compareDocumentPosition(passkey) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('disables the passkey button until the required consent is given', async () => {
    mockStatus({ passkey_login: true, user_agreement_enabled: true })

    renderSignInForm()

    expect(
      await screen.findByRole('button', { name: 'Sign in with Passkey' })
    ).toBeDisabled()
  })

  it('renders no alternative methods when the deployment enables none', async () => {
    mockStatus({})

    renderSignInForm()

    await screen.findByRole('button', { name: 'Sign in' })
    expect(
      screen.queryByRole('button', { name: 'Sign in with Passkey' })
    ).toBeNull()
  })
})
