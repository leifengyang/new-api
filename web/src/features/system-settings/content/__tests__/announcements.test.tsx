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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { AnnouncementsSection } from '../announcements-section'

const draft = {
  id: 1,
  title: 'Preview title',
  content: 'Preview announcement',
  publishDate: '2020-01-01T00:00:00Z',
  type: 'default',
  popupTarget: 'home',
  published: false,
}
let client: QueryClient
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
})
afterEach(() => {
  client.clear()
  Reflect.deleteProperty(Element.prototype, 'getAnimations')
})
function renderSettings(data: unknown[] = [draft]) {
  return render(
    <QueryClientProvider client={client}>
      <AnnouncementsSection data={JSON.stringify(data)} enabled />
    </QueryClientProvider>
  )
}

test('adding an announcement saves a private draft without a publication revision', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderSettings([])
  await user.click(screen.getByRole('button', { name: 'Add Announcement' }))
  const editor = await screen.findByRole('dialog', { name: 'Add Announcement' })
  await user.type(within(editor).getByLabelText('Title'), 'New title')
  await user.type(within(editor).getByLabelText('Content'), 'New announcement')
  await user.click(within(editor).getByRole('button', { name: 'Save draft' }))
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  const saved = JSON.parse((put.mock.calls[0][1] as { value: string }).value)
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({
    content: 'New announcement',
    popupTarget: 'authenticated',
    published: false,
  })
  expect(saved[0].revision).toBeUndefined()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Test popup' })).toBeVisible()
  )
})

test('testing and closing a draft does not publish; confirmation saves the previewed content', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('button', { name: 'Test popup' }))
  let popup = await screen.findByRole('dialog', {
    name: 'Announcements',
  })
  expect(within(popup).getByText(draft.content)).toBeVisible()
  expect(put).not.toHaveBeenCalled()
  await user.click(within(popup).getAllByRole('button', { name: 'Close' })[0])
  expect(put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Test popup' }))
  popup = await screen.findByRole('dialog', { name: 'Announcements' })
  await user.click(
    within(popup).getByRole('button', { name: 'Confirm publication' })
  )
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  const saved = JSON.parse((put.mock.calls[0][1] as { value: string }).value)
  expect(saved[0]).toMatchObject({ ...draft, published: true })
  expect(saved[0].revision).toEqual(expect.any(String))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})

test('saving an edit withdraws a published announcement and requires a new confirmation', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderSettings([{ ...draft, published: true, revision: 'old' }])
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const editor = await screen.findByRole('dialog', {
    name: 'Edit Announcement',
  })
  await user.clear(within(editor).getByLabelText('Content'))
  await user.type(
    within(editor).getByLabelText('Content'),
    'Updated announcement'
  )
  await user.click(within(editor).getByRole('button', { name: 'Save draft' }))
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  expect(
    JSON.parse((put.mock.calls[0][1] as { value: string }).value)[0]
  ).toMatchObject({
    content: 'Updated announcement',
    published: false,
    popupTarget: 'home',
  })
  await waitFor(() =>
    expect(screen.getAllByText('Draft', { exact: true })[0]).toBeVisible()
  )
})

test('failed publication keeps the draft and preview available for retry', async () => {
  vi.spyOn(api, 'put').mockRejectedValue(new Error('Offline'))
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('button', { name: 'Test popup' }))
  const popup = await screen.findByRole('dialog')
  await user.click(
    within(popup).getByRole('button', { name: 'Confirm publication' })
  )
  await waitFor(() =>
    expect(
      within(popup).getByRole('button', { name: 'Confirm publication' })
    ).toBeEnabled()
  )
  expect(popup).toBeVisible()
  expect(screen.getAllByText('Draft', { exact: true })[0]).toBeInTheDocument()
})

test('image edits require saving a draft and previewing the complete popup before publication', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderSettings([{ ...draft, published: true, revision: 'v1' }])
  await user.type(
    screen.getByLabelText('Image URL'),
    'https://example.com/community.png'
  )
  await user.type(
    screen.getByLabelText('Image link (optional)'),
    'https://example.com/group'
  )
  expect(
    screen.getByRole('button', { name: 'Preview homepage popup' })
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Save image draft' }))
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  expect(
    JSON.parse((put.mock.calls[0][1] as { value: string }).value)
  ).toMatchObject({ published: false })
  await user.click(
    screen.getByRole('button', { name: 'Preview homepage popup' })
  )
  const popup = await screen.findByRole('dialog', { name: 'Announcements' })
  expect(
    within(popup).getByRole('img', { name: 'Permanent announcement' })
  ).toHaveAttribute('src', 'https://example.com/community.png')
  expect(within(popup).getByText('Preview title')).toBeVisible()
  expect(put).toHaveBeenCalledTimes(1)
  await user.click(
    within(popup).getByRole('button', { name: 'Confirm publication' })
  )
  await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
  expect(
    JSON.parse((put.mock.calls[1][1] as { value: string }).value)
  ).toMatchObject({
    imageUrl: 'https://example.com/community.png',
    linkUrl: 'https://example.com/group',
    published: true,
    revision: expect.any(String),
  })
})

test('image upload uses the same draft workflow and rejects oversized files', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderSettings([])
  const input = screen.getByLabelText('Upload image')
  await user.upload(
    input,
    new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    })
  )
  expect(
    screen.getByRole('button', { name: 'Save image draft' })
  ).toBeDisabled()
  await user.upload(
    input,
    new File(['image fixture'], 'image.png', { type: 'image/png' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save image draft' })
    ).toBeEnabled()
  )
  await user.click(screen.getByRole('button', { name: 'Save image draft' }))
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  expect(
    JSON.parse((put.mock.calls[0][1] as { value: string }).value)
  ).toMatchObject({
    imageUrl: expect.stringMatching(/^data:image\/png;base64,/),
    published: false,
  })
})
