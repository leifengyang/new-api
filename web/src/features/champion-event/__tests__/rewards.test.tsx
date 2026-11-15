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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { ChampionAdmin } from '../admin'
import type { ChampionAdminData, ChampionAward } from '../api'
import { ChampionHonors } from '../honors'
import { ChampionNotice, EquippedChampionBadge } from '../notice'

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ auth: { user: { id: 1 } } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: (props: {
    to: string
    children: ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <a href={props.to} onClick={props.onClick} className={props.className}>
      {props.children}
    </a>
  ),
}))

let award: ChampionAward | null
let admin: ChampionAdminData
let failSave: boolean

beforeEach(() => {
  failSave = false
  award = {
    id: 5,
    user_id: 1,
    username: '测试用户🌟',
    spend: 500000,
    position: 3,
    reason: '',
    quota: 33300000,
    status: 'credited',
    credited_at: 1794758400,
    equipped: 3,
    read_at: 0,
    notice_seen_at: 0,
  }
  admin = {
    event: {
      status: 'draft',
      published: false,
      excluded_ids: '[]',
      revision: 3,
      snapshot_at: 1794758401,
      snapshot_end: 1794758400,
      participants: 8,
      total_quota: 233600000,
      unknown_logs: 0,
    },
    items: [award],
    total: 1,
    start_at: 1794585600,
    end_at: 1794758400,
    server_time: 1794758402,
    credited: 0,
    pending: 0,
    skipped: 0,
  }
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    let data: unknown = award
    if (url.endsWith('/messages')) data = { items: [], total: 0 }
    if (url.endsWith('/admin')) data = admin
    return { data: { success: true, data } }
  })
  vi.spyOn(api, 'put').mockImplementation(async (_url, body) => {
    if (failSave) return { data: { success: false, message: 'Save failed' } }
    const change = body as { equipped?: number; seen?: boolean; read?: boolean }
    if (award && change.equipped !== undefined) {
      award = { ...award, equipped: change.equipped }
    }
    if (award && change.seen) award = { ...award, notice_seen_at: 1794758403 }
    if (award && change.read) award = { ...award, read_at: 1794758403 }
    return { data: { success: true } }
  })
  vi.spyOn(api, 'post').mockResolvedValue({ data: { success: true } })
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

test('winner can switch to the memorial badge, hide it and retain both permanent honors', async () => {
  const { user } = setup(
    <>
      <ChampionHonors />
      <EquippedChampionBadge />
    </>
  )
  await screen.findByText('Champion mid laner')
  expect(screen.getByRole('button', { name: 'Equipped' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Equip badge' }))
  await waitFor(() => expect(award?.equipped).toBe(8))
  await user.click(screen.getByRole('button', { name: 'Hide equipped badge' }))
  await screen.findByRole('button', { name: 'Badge hidden' })
  expect(
    screen.queryByRole('link', { name: 'View my honors' })
  ).not.toBeInTheDocument()
  expect(screen.getByText('Champion mid laner')).toBeInTheDocument()
  expect(
    screen.getByText('Championship commemorative badge')
  ).toBeInTheDocument()
})

test('participant outside top seven only sees the memorial entitlement', async () => {
  if (!award) throw new Error('Missing fixture')
  award = { ...award, position: 8, quota: 500000, equipped: 8 }
  setup(<ChampionHonors />)
  await screen.findByText('Championship commemorative badge')
  expect(screen.queryByText('Champion mid laner')).not.toBeInTheDocument()
  expect(screen.getAllByText('S16 2026 · Owned permanently')).toHaveLength(1)
})

test('failed badge update preserves the equipped state', async () => {
  failSave = true
  const { user } = setup(<ChampionHonors />)
  await screen.findByText('Champion mid laner')
  await user.click(screen.getByRole('button', { name: 'Hide equipped badge' }))
  await waitFor(() => expect(api.put).toHaveBeenCalled())
  expect(award?.equipped).toBe(3)
  expect(
    screen.queryByRole('button', { name: 'Badge hidden' })
  ).not.toBeInTheDocument()
})

test('closing reward notice persists dismissal while leaving the inbox unread', async () => {
  const { user, view, client } = setup(<ChampionNotice />)
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('link', { name: 'View my honors' }))
  await waitFor(() => expect(award?.notice_seen_at).toBeGreaterThan(0))
  expect(award?.read_at).toBe(0)
  view.unmount()
  render(
    <QueryClientProvider client={client}>
      <ChampionNotice />
    </QueryClientProvider>
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('empty wallet honors explains when rewards become available', async () => {
  award = null
  setup(<ChampionHonors />)
  await screen.findByText('No championship reward yet')
  expect(
    screen.queryByRole('button', { name: 'Equip badge' })
  ).not.toBeInTheDocument()
})

test('before cutoff the administrator can preview but cannot confirm rewards', async () => {
  admin.server_time = admin.end_at - 1
  setup(<ChampionAdmin />)
  await screen.findByRole('button', { name: 'Generate award preview' })
  expect(
    screen.getByRole('button', { name: 'Confirm and award' })
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Generate award preview' })
  ).toBeEnabled()
})

test('confirmation requires a review dialog and sends the displayed revision once', async () => {
  const { user } = setup(<ChampionAdmin />)
  await user.click(
    await screen.findByRole('button', { name: 'Confirm and award' })
  )
  expect(api.post).not.toHaveBeenCalled()
  const dialog = screen.getByRole('alertdialog')
  await user.click(
    within(dialog).getByRole('button', { name: 'Confirm and award' })
  )
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/api/user/champion-event/admin/confirm',
      { revision: 3 }
    )
  )
  expect(api.post).toHaveBeenCalledTimes(1)
})

test('invalid exclusion IDs stay in the form and never change the server list', async () => {
  const { user } = setup(<ChampionAdmin />)
  const input = await screen.findByRole('textbox', {
    name: 'Excluded test account IDs',
  })
  await user.type(input, '0, -4, abc')
  await user.click(screen.getByRole('button', { name: 'Save exclusions' }))
  await screen.findByRole('alert')
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(api.put).not.toHaveBeenCalled()
})

test('frozen award list disables preview and exclusion changes', async () => {
  admin.event.status = 'awarding'
  setup(<ChampionAdmin />)
  await screen.findByRole('button', { name: 'Retry pending rewards' })
  expect(
    screen.getByRole('textbox', { name: 'Excluded test account IDs' })
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Generate award preview' })
  ).toBeDisabled()
})

test('unread compensation queues behind the reward notice without blocking it', async () => {
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages')
        ? {
            items: [
              {
                id: 7,
                revision: 1,
                quota: 500000,
                count: 1,
                start_at: 1794585600,
                end_at: 1794758400,
              },
            ],
            total: 1,
          }
        : award,
    },
  }))
  const { user } = setup(<ChampionNotice />)
  const reward = await screen.findByRole('dialog', {
    name: 'Glory belongs to you',
  })
  expect(
    screen.queryByRole('dialog', { name: 'Stream compensation received' })
  ).not.toBeInTheDocument()
  await user.click(within(reward).getByRole('link', { name: 'View my honors' }))
  await screen.findByRole('dialog', { name: 'Stream compensation received' })
  expect(award?.read_at).toBe(0)
})

test('a changed preview disables the open confirmation until the new list is reviewed', async () => {
  const { user, client } = setup(<ChampionAdmin />)
  await user.click(
    await screen.findByRole('button', { name: 'Confirm and award' })
  )
  const dialog = screen.getByRole('alertdialog')
  admin = { ...admin, event: { ...admin.event, revision: 4 } }
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['champion-event', 'admin'] })
  })
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Confirm and award' })
    ).toBeDisabled()
  )
  await user.click(
    within(dialog).getByRole('button', { name: 'Confirm and award' })
  )
  expect(api.post).not.toHaveBeenCalled()
})
