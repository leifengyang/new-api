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
    name: 'Announcement Details',
  })
  expect(within(popup).getByText(draft.content)).toBeVisible()
  expect(put).not.toHaveBeenCalled()
  await user.click(within(popup).getAllByRole('button', { name: 'Close' })[0])
  expect(put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Test popup' }))
  popup = await screen.findByRole('dialog', { name: 'Announcement Details' })
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
    expect(screen.getByText('Draft', { exact: true })).toBeVisible()
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
  expect(screen.getByText('Draft', { exact: true })).toBeInTheDocument()
})
