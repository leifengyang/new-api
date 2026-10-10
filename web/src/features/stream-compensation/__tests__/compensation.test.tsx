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
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CompensationAdmin } from '../admin'
import { CompensationNotice } from '../messages'
import { CompensationRecords } from '../records'

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ auth: { user: { id: 1 } } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: (props: {
    to: string
    children: ReactNode
    className?: string
    onClick?: () => void
  }) => (
    <a href={props.to} className={props.className} onClick={props.onClick}>
      {props.children}
    </a>
  ),
}))

const record = {
  id: 1,
  batch_id: 1,
  user_id: 1,
  request_id: 'request-test',
  model_name: 'test-model',
  consumed_at: 1790800000,
  original_quota: 10000,
  quota: 10000,
  status: 'review',
  note: 'cache_unknown',
  reason: 'client_gone',
  credited_at: 0,
}
let acknowledged = false
let failRead = false

beforeEach(() => {
  acknowledged = false
  failRead = false
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    let data: unknown = {
      items: [record],
      total: 21,
      totals: { original_quota: 10000, credited_quota: 0, net_quota: 10000 },
    }
    if (url.endsWith('/messages')) {
      data = {
        items: acknowledged
          ? []
          : [
              {
                id: 5,
                batch_id: 1,
                quota: 50000,
                count: 3,
                start_at: 1790784000,
                end_at: 1790956800,
                revision: 7,
                read_at: 0,
              },
            ],
        total: acknowledged ? 0 : 1,
      }
    }
    if (url.endsWith('/settings')) {
      data = { enabled: false, settled_until: 1790784000 }
    }
    if (url.endsWith('/batches')) data = { items: [], total: 0 }
    return { data: { success: true, data } }
  })
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (failRead) return { data: { success: false, message: 'Could not save' } }
    if (url.endsWith('/read')) acknowledged = true
    return { data: { success: true } }
  })
})

function setup(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  )
  return { client, view, user: userEvent.setup() }
}

test('wallet ledger keeps original charges and paginates without exposing admin review actions', async () => {
  const { user, client } = setup(<CompensationRecords />)
  await screen.findByText('test-model')
  expect(
    screen.queryByRole('button', { name: 'Approve' })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Original request' })
  ).toHaveAttribute('href', '/usage-logs/$section')
  await user.click(screen.getByRole('button', { name: 'Go to next page' }))
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      '/api/user/stream-compensation',
      expect.objectContaining({ params: expect.objectContaining({ p: 2 }) })
    )
  )
  client.clear()
})

test('admin review credits only after confirmation and keeps the confirmation open on failure', async () => {
  const { user, client } = setup(<CompensationRecords admin />)
  await user.click(await screen.findByRole('button', { name: 'Approve' }))
  expect(api.post).not.toHaveBeenCalled()
  failRead = true
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Continue',
    })
  )
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/api/user/stream-compensation/admin/1/review',
      { approve: true }
    )
  )
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  client.clear()
})

test('unread arrival popup acknowledges the exact message revision only after Got it', async () => {
  const { user, client } = setup(<CompensationNotice />)
  expect(await screen.findByText('Stream compensation received')).toBeVisible()
  expect(api.post).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Got it' }))
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/api/user/stream-compensation/messages/5/read',
      { revision: 7 }
    )
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  client.clear()
})

test('closing the arrival popup does not mark compensation as read', async () => {
  const { user, client } = setup(<CompensationNotice />)
  await screen.findByRole('dialog')
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(api.post).not.toHaveBeenCalled()
  client.clear()
})

test('disabled compensation prevents manual settlement and shows an empty batch state', async () => {
  const { client } = setup(<CompensationAdmin />)
  expect(
    await screen.findByRole('button', { name: 'Settle / retry now' })
  ).toBeDisabled()
  expect(await screen.findByText('No settlement batches')).toBeVisible()
  client.clear()
})
