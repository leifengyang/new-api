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
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { ChampionPublicData } from '../api'
import { Championship } from '../index'

let board: ChampionPublicData | null
let fail: boolean
beforeEach(() => {
  useAuthStore.getState().auth.reset()
  fail = false
  board = {
    status: 'draft',
    start_at: 1794585600,
    end_at: 1794758400,
    snapshot_at: 1794700000,
    winners: [{ position: 1, name: 'A***', status: 'preview' }],
  }
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/champion-event') {
      if (fail) throw new Error('Offline')
      return { data: { success: true, data: board } }
    }
    if (url === '/api/user/champion-event') {
      return {
        data: {
          success: true,
          data: { position: 9, spend: 500000, status: 'preview' },
        },
      }
    }
    if (url === '/api/announcements') {
      return { data: { success: true, data: [] } }
    }
    return { data: { success: true, data: url === '/api/notice' ? '' : {} } }
  })
})
afterEach(() => {
  useAuthStore.getState().auth.reset()
})
function setup() {
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: '/championship',
    component: Championship,
  })
  const signIn = createRoute({
    getParentRoute: () => root,
    path: '/sign-in',
    component: () => <h1>Sign in destination</h1>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page, signIn]),
    history: createMemoryHistory({ initialEntries: ['/championship'] }),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { user: userEvent.setup(), router }
}
test('unpublished activity shows its empty state without disclosing a winner', async () => {
  board = null
  setup()
  await screen.findByText('The championship activity is not published yet')
  expect(screen.queryByText('A***')).not.toBeInTheDocument()
})
test('guest sees seven masked seats and can sign in from their activity progress', async () => {
  const { user, router } = setup()
  await screen.findByText('Provisional ranking')
  expect(screen.getByText('A***')).toBeVisible()
  const cards = screen.getAllByRole('article')
  expect(cards).toHaveLength(7)
  expect(cards[0].parentElement).toHaveClass('grid-cols-2', 'lg:grid-cols-4')
  const progress = screen.getByRole('heading', {
    name: 'My activity progress',
  }).parentElement
  if (!progress) throw new Error('Missing progress section')
  const signIn = within(progress).getByRole('button', { name: 'Sign in' })
  await user.click(signIn)
  await screen.findByRole('heading', { name: 'Sign in destination' })
  expect(router.state.location.search).toEqual({ redirect: '/championship' })
  expect(
    vi
      .mocked(api.get)
      .mock.calls.some(([url]) => url === '/api/user/champion-event')
  ).toBe(false)
})
test('signed-in participant sees final rank and own consumption', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'participant', role: 1 })
  if (!board) throw new Error('Missing board')
  board = { ...board, status: 'completed' }
  setup()
  await screen.findByText('Final ranking')
  await screen.findByText('Rank: 9')
  expect(screen.getByText('Activity consumption: $1')).toBeVisible()
})
test('failed public request offers retry and recovers the board', async () => {
  fail = true
  const { user } = setup()
  const retry = await screen.findByRole('button', { name: 'Retry' })
  fail = false
  await user.click(retry)
  await screen.findByText('Provisional ranking')
})
