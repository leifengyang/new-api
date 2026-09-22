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
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { UserAuthForm } from '../user-auth-form'

function mockStatus(overrides: Record<string, unknown> = {}) {
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

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Sign-in credential fields', () => {
  it('lets a password manager fill and save the account it signs in with', async () => {
    mockStatus()
    renderSignInForm()

    const username = await screen.findByLabelText('Username or Email')
    const password = screen.getByLabelText('Password')

    expect(username).toHaveAttribute('autocomplete', 'username')
    expect(username).toHaveAttribute('spellcheck', 'false')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
    expect(password).toHaveAttribute('type', 'password')
  })

  it('keeps the image captcha numeric and capped at the code length', async () => {
    mockStatus()
    renderSignInForm()

    const captcha = await screen.findByLabelText('Image captcha code')

    expect(captcha).toHaveAttribute('inputmode', 'numeric')
    expect(captcha).toHaveAttribute('maxlength', '6')
    expect(captcha).toHaveAttribute('autocomplete', 'off')
  })

  it('keeps submit clickable while the captcha is still empty', async () => {
    mockStatus()
    renderSignInForm()

    const submit = await screen.findByRole('button', { name: 'Sign in' })

    await waitFor(() => expect(submit).toBeEnabled())
  })

  it('names the missing captcha code and moves focus there on submit', async () => {
    const user = userEvent.setup()
    mockStatus()
    renderSignInForm()

    await user.type(await screen.findByLabelText('Username or Email'), 'ada')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    const captcha = await screen.findByLabelText('Image captcha code')
    await waitFor(() => expect(captcha).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the 6-digit code from the image'
    )
    expect(captcha).toHaveFocus()
    expect(captcha).toHaveAttribute('aria-invalid', 'true')
  })

  it('clears the captcha complaint as soon as the visitor types a code', async () => {
    const user = userEvent.setup()
    mockStatus()
    renderSignInForm()

    await user.type(await screen.findByLabelText('Username or Email'), 'ada')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    const captcha = await screen.findByLabelText('Image captcha code')
    await waitFor(() => expect(captcha).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('alert')

    await user.type(captcha, '1')

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('names the unticked consent and moves focus there on submit', async () => {
    const user = userEvent.setup()
    mockStatus({ user_agreement_enabled: true })
    renderSignInForm()

    await user.type(await screen.findByLabelText('Username or Email'), 'ada')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    const captcha = await screen.findByLabelText('Image captcha code')
    await waitFor(() => expect(captcha).toBeEnabled())
    await user.type(captcha, '123456')

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please agree to the legal terms first'
    )
    expect(screen.getByRole('checkbox')).toHaveFocus()
  })
})
