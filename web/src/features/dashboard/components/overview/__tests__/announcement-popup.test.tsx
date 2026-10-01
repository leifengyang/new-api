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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { AnnouncementItem } from '@/features/dashboard/types'

import { AnnouncementPopup } from '../announcement-popup'

const home: AnnouncementItem = {
  id: 1,
  title: 'Service update',
  content: 'Public announcement',
  publishDate: '2020-01-01T00:00:00Z',
  popupTarget: 'home',
  published: true,
  revision: 'v1',
}
const privateItem: AnnouncementItem = {
  ...home,
  id: 2,
  title: 'Member update',
  content: 'Private announcement',
  popupTarget: 'authenticated',
}
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
})
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'getAnimations')
})

test('homepage selects the latest three due public announcements and expands details inside the popup', async () => {
  const user = userEvent.setup()
  render(
    <AnnouncementPopup
      items={[
        privateItem,
        { ...home, id: 3, title: 'Draft', published: false },
        {
          ...home,
          id: 4,
          title: 'Future',
          publishDate: '2999-01-01T00:00:00Z',
        },
        { ...home, id: 5, title: 'Older', publishDate: '2019-01-01T00:00:00Z' },
        home,
        {
          ...home,
          id: 6,
          title: 'Second',
          publishDate: '2020-01-02T00:00:00Z',
        },
        {
          ...home,
          id: 7,
          title: 'Newest',
          publishDate: '2020-01-03T00:00:00Z',
        },
      ]}
      target='home'
      trigger='home'
    />
  )
  const region = await screen.findByRole('region', {
    name: 'Latest announcements',
  })
  expect(
    within(region)
      .getAllByRole('button')
      .map((button) => button.textContent)
  ).toEqual([
    expect.stringContaining('Newest'),
    expect.stringContaining('Second'),
    expect.stringContaining('Service update'),
  ])
  expect(screen.queryByText('Member update')).not.toBeInTheDocument()
  expect(screen.queryByText('Draft')).not.toBeInTheDocument()
  expect(screen.queryByText('Future')).not.toBeInTheDocument()
  expect(screen.queryByText('Older')).not.toBeInTheDocument()
  await user.click(
    within(region).getByRole('button', { name: /Service update/ })
  )
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('heading', { name: 'Service update' })).toBeVisible()
  await user.click(
    screen.getByRole('button', { name: 'Back to announcements' })
  )
  expect(within(region).getAllByRole('button')).toHaveLength(3)
})

test('closing stays closed during polling, but returning to the homepage opens again', async () => {
  const user = userEvent.setup()
  const view = render(
    <AnnouncementPopup items={[home]} target='home' trigger='home' />
  )
  await user.click(await screen.findByRole('button', { name: 'Got it' }))
  view.rerender(
    <AnnouncementPopup
      items={[{ ...home, revision: 'v2' }]}
      target='home'
      trigger='home'
    />
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  view.unmount()
  render(<AnnouncementPopup items={[home]} target='home' trigger='home' />)
  expect(await screen.findByRole('dialog')).toBeVisible()
})

test('login requires an actual login event and does not repeat when navigating console pages', async () => {
  const user = userEvent.setup()
  const view = render(
    <AnnouncementPopup
      items={[home, privateItem]}
      target='authenticated'
      trigger={null}
    />
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  view.rerender(
    <AnnouncementPopup
      items={[home, privateItem]}
      target='authenticated'
      trigger='login:1'
      active={false}
    />
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  view.rerender(
    <AnnouncementPopup
      items={[home, privateItem]}
      target='authenticated'
      trigger='login:1'
    />
  )
  expect(await screen.findByText('Member update')).toBeVisible()
  expect(screen.queryByText('Service update')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Got it' }))
  view.rerender(
    <AnnouncementPopup
      items={[privateItem]}
      target='authenticated'
      trigger='login:1'
      active={false}
    />
  )
  view.rerender(
    <AnnouncementPopup
      items={[privateItem]}
      target='authenticated'
      trigger='login:1'
    />
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  view.rerender(
    <AnnouncementPopup
      items={[privateItem]}
      target='authenticated'
      trigger='login:2'
    />
  )
  expect(await screen.findByText('Member update')).toBeVisible()
})

test('only a published banner can open an otherwise empty popup and its link is accessible', async () => {
  const banner = {
    imageUrl: 'https://example.com/banner.png',
    linkUrl: 'https://example.com/community',
    published: false,
  }
  const view = render(
    <AnnouncementPopup
      items={[]}
      banner={banner}
      target='home'
      trigger='home'
    />
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  view.rerender(
    <AnnouncementPopup
      items={[]}
      banner={{ ...banner, published: true }}
      target='home'
      trigger='next-visit'
    />
  )
  expect(
    await screen.findByRole('img', { name: 'Permanent announcement' })
  ).toBeVisible()
  expect(screen.getByRole('link')).toHaveAttribute('href', banner.linkUrl)
  expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByText('No announcements')).toBeVisible()
})

test('an empty login response completes the visit while loading waits for announcements', async () => {
  const view = render(
    <AnnouncementPopup
      items={[]}
      target='authenticated'
      trigger='login:1'
      loading
    />
  )
  view.rerender(
    <AnnouncementPopup
      items={[privateItem]}
      target='authenticated'
      trigger='login:1'
    />
  )
  expect(await screen.findByText('Member update')).toBeVisible()
  view.rerender(
    <AnnouncementPopup items={[]} target='authenticated' trigger='login:2' />
  )
  view.rerender(
    <AnnouncementPopup
      items={[privateItem]}
      target='authenticated'
      trigger='login:2'
    />
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})
