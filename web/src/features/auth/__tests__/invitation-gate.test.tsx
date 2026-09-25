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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { STATUS_QUERY_KEY } from '@/lib/status-query'

import { isRegistrationOpen } from '../lib/invitation'
import { saveAffiliateCode } from '../lib/storage'
import { SignIn } from '../sign-in'
import { SignUp } from '../sign-up'

const png = 'data:image/png;base64,iVBORw0KGgo='
const INVITE_TITLE = 'Invite-Only Registration'
const INVITE_MESSAGE =
  'Internal platform, not open to the public. Registration is not permitted.'

type StatusOverrides = Record<string, unknown>

function mockApi(status: StatusOverrides) {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/captcha') {
      return {
        data: {
          success: true,
          data: { captcha_id: 'challenge', image: png, expires_in: 300 },
        },
      }
    }
    return { data: { success: true, data: status } }
  })
}

/**
 * Render an auth page the way production reaches it: the route guard resolves
 * `/api/status` before the component renders, so the page never paints a state
 * of its own that the switch would immediately contradict.
 */
function renderAuthPage(path: string, status: StatusOverrides) {
  mockApi(status)
  window.history.replaceState({}, '', path)

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(STATUS_QUERY_KEY, status)

  const root = createRootRoute({ component: Outlet })
  // 与真实路由树同形：路径无关的 (auth) 布局下挂 sign-in / sign-up，SignIn 才
  // 能用它声明的 `from: '/(auth)/sign-in'` 找到自己的搜索参数。
  const authLayout = createRoute({ getParentRoute: () => root, id: '/(auth)' })
  const authRoutes = [
    createRoute({
      getParentRoute: () => authLayout,
      path: '/sign-up',
      component: SignUp,
    }),
    createRoute({
      getParentRoute: () => authLayout,
      path: '/sign-in',
      component: SignIn,
    }),
  ]
  const routes = [
    authLayout.addChildren(authRoutes),
    createRoute({
      getParentRoute: () => root,
      path: '/forgot-password',
      component: () => <div>Forgot password page</div>,
    }),
  ]
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  })

  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

it('leaves registration open when the switch is off', () => {
  expect(
    isRegistrationOpen({ invite_only_registration_enabled: false } as never)
  ).toBe(true)
})

it('leaves registration open while the status has not loaded', () => {
  expect(isRegistrationOpen(undefined)).toBe(true)
})

it('closes registration when the switch is on and no invitation was presented', () => {
  expect(
    isRegistrationOpen({ invite_only_registration_enabled: true } as never)
  ).toBe(false)
})

it('opens registration for an invitation link before its code is persisted', () => {
  window.history.replaceState({}, '', '/sign-up?aff=INVITE1')
  expect(
    isRegistrationOpen({ invite_only_registration_enabled: true } as never)
  ).toBe(true)
})

it('opens registration for a previously stored invitation code', () => {
  saveAffiliateCode('INVITE2')
  expect(
    isRegistrationOpen({ invite_only_registration_enabled: true } as never)
  ).toBe(true)
})

it('shows the internal-only notice instead of the registration form', async () => {
  renderAuthPage('/sign-up', { invite_only_registration_enabled: true })

  expect(await screen.findByText(i18n.t(INVITE_TITLE))).toBeInTheDocument()
  expect(screen.getByText(i18n.t(INVITE_MESSAGE))).toBeInTheDocument()
  expect(screen.queryByLabelText(i18n.t('Username'))).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: i18n.t('Create account') })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: i18n.t('Sign in') })
  ).toHaveAttribute('href', '/sign-in')
})

it('renders the registration form for a visit that carries an invitation code', async () => {
  renderAuthPage('/sign-up?aff=INVITE3', {
    invite_only_registration_enabled: true,
  })

  expect(await screen.findByLabelText(i18n.t('Username'))).toBeInTheDocument()
  expect(screen.queryByText(i18n.t(INVITE_MESSAGE))).not.toBeInTheDocument()
})

it('renders the registration form when the switch is off', async () => {
  renderAuthPage('/sign-up', { invite_only_registration_enabled: false })

  expect(await screen.findByLabelText(i18n.t('Username'))).toBeInTheDocument()
  expect(screen.queryByText(i18n.t(INVITE_MESSAGE))).not.toBeInTheDocument()
})

it('hides the sign-up entry on the sign-in page without an invitation', async () => {
  renderAuthPage('/sign-in', { invite_only_registration_enabled: true })

  expect(
    await screen.findByRole('heading', { name: i18n.t('Sign in') })
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: i18n.t('Sign up') })
  ).not.toBeInTheDocument()
})

it('keeps the sign-up entry on the sign-in page for an invited visitor', async () => {
  saveAffiliateCode('INVITE4')
  renderAuthPage('/sign-in', { invite_only_registration_enabled: true })

  expect(
    await screen.findByRole('link', { name: i18n.t('Sign up') })
  ).toHaveAttribute('href', '/sign-up')
})
