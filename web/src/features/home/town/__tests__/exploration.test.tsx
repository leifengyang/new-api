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
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { journeyAt } from '../town-data'
import { TownExperience } from '../town-experience'

async function renderTown(isAuthenticated = false) {
  const root = createRootRoute()
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <TownExperience isAuthenticated={isAuthenticated} />,
  })
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByText(
    'Enjoy the illustrated view. Model exploration is still available below.'
  )
  return userEvent.setup()
}

beforeEach(async () => {
  await i18next.changeLanguage('en')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  // WebGL is an external browser boundary; the actual scene import and fallback run.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

describe('model town', () => {
  it('keeps model exploration and navigation available when WebGL is unavailable', async () => {
    const user = await renderTown()
    const districts = screen.getByRole('group', {
      name: 'Choose a model district',
    })
    const vision = within(districts).getByRole('button', {
      name: 'Prism Garden',
    })
    await user.click(vision)
    expect(vision).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('heading', { name: 'Give imagination a shape' })
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send a spark' })).toBeDisabled()
    expect(
      screen.getByRole('link', { name: 'Start creating' })
    ).toHaveAttribute('href', '/sign-in')
    expect(
      screen.getByRole('link', { name: 'Explore models' })
    ).toHaveAttribute('href', '/pricing')
  })

  it('lets keyboard users explore a district and retry an unavailable scene', async () => {
    const user = await renderTown()
    const districts = screen.getByRole('group', {
      name: 'Choose a model district',
    })
    const audio = within(districts).getByRole('button', {
      name: 'Echo Pavilion',
    })
    audio.focus()
    await user.keyboard('{Enter}')
    expect(
      screen.getByRole('heading', { name: 'Every idea has a voice' })
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Retry interactive view' })
    )
    await screen.findByText(
      'Enjoy the illustrated view. Model exploration is still available below.'
    )
    expect(document.querySelectorAll('.town-canvas canvas')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Send a spark' })).toBeDisabled()
    expect(
      within(districts).getByRole('button', { name: 'Aurora Nexus' })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('links authenticated visitors to their dashboard', async () => {
    await renderTown(true)
    expect(
      screen.getByRole('link', { name: 'Go to Dashboard' })
    ).toHaveAttribute('href', '/dashboard')
    expect(
      screen.queryByRole('link', { name: 'Start creating' })
    ).not.toBeInTheDocument()
  })

  it('updates the selected district copy when the language changes', async () => {
    const user = await renderTown()
    i18next.addResourceBundle('zh', 'translation', {
      'Echo Pavilion': '回声之境',
      'Every idea has a voice': '让每个想法被听见',
    })
    const districts = screen.getByRole('group', {
      name: 'Choose a model district',
    })
    await user.click(
      within(districts).getByRole('button', { name: 'Echo Pavilion' })
    )
    await act(() => i18next.changeLanguage('zh'))
    expect(
      within(districts).getByRole('button', { name: '回声之境' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('heading', { name: '让每个想法被听见' })
    ).toBeVisible()
    i18next.removeResourceBundle('zh', 'translation')
  })

  it.each([
    [0, 'routing', 0],
    [2, 'memory', 2 / 9],
    [4.3, 'generating', 4.3 / 9],
    [6.8, 'returning', 6.8 / 9],
    [9, 'complete', 1],
    [15, 'complete', 1],
  ] as const)(
    'at %s seconds the demonstration reports %s',
    (seconds, stage, progress) => {
      expect(journeyAt(seconds)).toEqual({ stage, progress })
    }
  )
})
