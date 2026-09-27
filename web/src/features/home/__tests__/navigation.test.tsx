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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import zh from '@/i18n/locales/zh.json'

import { SimpleHome } from '../components/simple-home'

async function renderHome(isAuthenticated: boolean) {
  const root = createRootRoute()
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <SimpleHome isAuthenticated={isAuthenticated} />,
  })
  const destinations = ['/sign-in', '/dashboard', '/pricing'].map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <h1>{path}</h1>,
    })
  )
  const router = createRouter({
    routeTree: root.addChildren([index, ...destinations]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { level: 1 })
  return userEvent.setup()
}

beforeEach(async () => {
  await i18next.changeLanguage('en')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})

afterEach(() => {
  i18next.removeResourceBundle('zh', 'translation')
})

describe('simple home navigation', () => {
  it.each([
    [false, 'Start creating', '/sign-in'],
    [true, 'Go to Dashboard', '/dashboard'],
  ] as const)(
    'when authenticated is %s, the primary action opens %s with the keyboard',
    async (authenticated, label, destination) => {
      const user = await renderHome(authenticated)
      await user.tab()
      expect(screen.getByRole('link', { name: label })).toHaveFocus()
      await user.keyboard('{Enter}')
      expect(
        await screen.findByRole('heading', { name: destination })
      ).toBeVisible()
    }
  )

  it('opens the model catalog from the secondary action', async () => {
    const user = await renderHome(false)
    await user.click(screen.getByRole('link', { name: 'Explore models' }))
    expect(
      await screen.findByRole('heading', { name: '/pricing' })
    ).toBeVisible()
  })

  it('updates the headline and keeps navigation available when the language changes', async () => {
    await renderHome(false)
    i18next.addResourceBundle('zh', 'translation', zh.translation)
    await act(() => i18next.changeLanguage('zh'))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      zh.translation['Good ideas.\nA simpler start.'].replace('\n', ' ')
    )
    expect(
      screen.getByRole('link', { name: zh.translation['Explore models'] })
    ).toHaveAttribute('href', '/pricing')
  })
})
