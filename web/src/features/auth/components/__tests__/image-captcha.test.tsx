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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { UserAuthForm } from '../../sign-in/components/user-auth-form'
import { SignUpForm } from '../../sign-up/components/sign-up-form'
import { ImageCaptcha } from '../image-captcha'

const png = 'data:image/png;base64,iVBORw0KGgo='

function Harness() {
  const [id, setId] = useState('')
  const [code, setCode] = useState('')
  return (
    <>
      <ImageCaptcha
        purpose='login'
        value={code}
        onChange={setCode}
        onCaptchaChange={setId}
      />
      <button type='button' disabled={!id || code.length !== 6}>
        Continue
      </button>
    </>
  )
}

function renderAuth(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({ component: () => ui })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return result
}

function setupNetwork() {
  let generation = 0
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/captcha') {
      generation++
      return {
        data: {
          success: true,
          data: {
            captcha_id: `challenge-${generation}`,
            image: png,
            expires_in: 300,
          },
        },
      }
    }
    return {
      data: {
        success: true,
        data: { password_login_enabled: true, oauth_register_enabled: false },
      },
    }
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'Request rejected' },
  })
  return { get, post }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('Image captcha', () => {
  it('clears the previous answer when refreshed using the keyboard', async () => {
    setupNetwork()
    const user = userEvent.setup()
    renderAuth(<Harness />)
    const input = await screen.findByLabelText('Image captcha code')
    await waitFor(() => expect(input).toBeEnabled())
    await user.type(input, '123456')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    screen.getByRole('button', { name: 'Refresh image captcha' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(input).toHaveValue(''))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('shows a recoverable error and blocks submission when loading fails', async () => {
    const { get } = setupNetwork()
    get.mockRejectedValueOnce(new Error('offline'))
    renderAuth(<Harness />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load the image captcha'
    )
    expect(screen.getByLabelText('Image captcha code')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh image captcha' })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Image captcha code')).toBeEnabled()
    )
  })

  it('invalidates an answer when the rendered image cannot load', async () => {
    setupNetwork()
    renderAuth(<Harness />)
    const image = await screen.findByRole('img', { name: 'Image captcha' })
    fireEvent.error(image)
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('expires the current challenge and requires an explicit refresh', async () => {
    setupNetwork()
    const timeout = vi.spyOn(window, 'setTimeout')
    renderAuth(<Harness />)
    const input = await screen.findByLabelText('Image captcha code')
    await waitFor(() => expect(input).toBeEnabled())
    await userEvent.type(input, '123456')
    const expiry = timeout.mock.calls.find(([, delay]) => delay === 300000)?.[0]
    expect(typeof expiry).toBe('function')
    act(() => {
      if (typeof expiry === 'function') expiry()
    })
    expect(screen.getByRole('status')).toHaveTextContent('expired')
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('sends the login captcha in JSON and replaces it after rejection', async () => {
    const { post } = setupNetwork()
    const user = userEvent.setup()
    renderAuth(<UserAuthForm />)
    const input = await screen.findByLabelText('Image captcha code')
    await waitFor(() => expect(input).toBeEnabled())
    await user.type(
      screen.getByPlaceholderText('Enter your username or email'),
      'captcha-user'
    )
    await user.type(
      screen.getByLabelText('Password', { exact: true }),
      'Example-password-2026'
    )
    const submit = screen.getByRole('button', { name: 'Sign in' })
    expect(submit).toBeDisabled()
    await user.type(input, '123456')
    await user.click(submit)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining('/api/user/login'),
        expect.objectContaining({
          captcha_id: 'challenge-1',
          captcha_code: '123456',
        }),
        expect.objectContaining({
          skipAuthRefresh: true,
        })
      )
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Image captcha code')).toHaveValue('')
    )
    expect(submit).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByLabelText('Image captcha code')).toBeEnabled()
    )
    await user.type(screen.getByLabelText('Image captcha code'), '654321')
    await user.click(submit)
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          captcha_id: 'challenge-2',
          captcha_code: '654321',
        }),
        expect.any(Object)
      )
    )
  })

  it('registers without requesting or sending an image captcha', async () => {
    const { get, post } = setupNetwork()
    const user = userEvent.setup()
    renderAuth(<SignUpForm />)
    await user.type(
      await screen.findByPlaceholderText('Enter your username'),
      'captcha-user'
    )
    await user.type(
      screen.getByLabelText('Password', { exact: true }),
      'Example-password-2026'
    )
    await user.type(
      screen.getByPlaceholderText('Confirm password'),
      'Example-password-2026'
    )
    expect(screen.queryByLabelText('Image captcha code')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, body] = post.mock.calls[0]
    expect(url).toContain('/api/user/register')
    expect(body).not.toHaveProperty('captcha_id')
    expect(body).not.toHaveProperty('captcha_code')
    expect(
      get.mock.calls.filter(([requestUrl]) => requestUrl === '/api/captcha')
    ).toHaveLength(0)
  })
})
