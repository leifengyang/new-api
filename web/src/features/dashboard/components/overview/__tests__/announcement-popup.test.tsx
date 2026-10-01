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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { AnnouncementItem } from '@/features/dashboard/types'

import { AnnouncementPopup } from '../announcement-popup'

const home: AnnouncementItem = {
  id: 1,
  content: 'Public announcement',
  popupTarget: 'home',
  published: true,
  revision: 'v1',
}
const privateItem: AnnouncementItem = {
  ...home,
  id: 2,
  content: 'Private announcement',
  popupTarget: 'authenticated',
}
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'getAnimations')
})

test('guest homepage shows public content and never shows a private or draft announcement', async () => {
  const view = render(
    <AnnouncementPopup
      items={[privateItem, { ...home, published: false }, home]}
      isHome
    />
  )
  expect(await screen.findByText(home.content)).toBeVisible()
  expect(screen.queryByText(privateItem.content)).not.toBeInTheDocument()
  view.rerender(
    <AnnouncementPopup items={[privateItem, home]} isHome={false} />
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})

test('dismissal survives remount while a new published revision shows again', async () => {
  const user = userEvent.setup()
  const view = render(<AnnouncementPopup items={[home]} isHome />)
  await user.click(await screen.findByRole('button', { name: 'Got it' }))
  view.unmount()
  const next = render(<AnnouncementPopup items={[home]} isHome />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  next.rerender(
    <AnnouncementPopup items={[{ ...home, revision: 'v2' }]} isHome />
  )
  expect(await screen.findByText(home.content)).toBeVisible()
})

test('private announcement receipts are separate for each signed-in account', async () => {
  const user = userEvent.setup()
  const view = render(
    <AnnouncementPopup items={[privateItem]} userId={1} isHome={false} />
  )
  await user.click(await screen.findByRole('button', { name: 'Got it' }))
  view.rerender(
    <AnnouncementPopup items={[privateItem]} userId={2} isHome={false} />
  )
  expect(await screen.findByText(privateItem.content)).toBeVisible()
  view.rerender(<AnnouncementPopup items={[privateItem]} isHome />)
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})

test('disabled browser storage still allows dismissal without repeated popups', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('Disabled')
    },
    setItem: () => {
      throw new Error('Disabled')
    },
  })
  const user = userEvent.setup()
  const view = render(<AnnouncementPopup items={[home]} isHome />)
  await user.click(await screen.findByRole('button', { name: 'Got it' }))
  view.rerender(<AnnouncementPopup items={[home]} isHome />)
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})
