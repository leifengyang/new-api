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
import type { ComponentProps, ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { useProfile } from '@/features/profile/hooks/use-profile'
import { api } from '@/lib/api'

import type { ChampionAward } from '../api'
import { ChampionHonors } from '../honors'
import { ChampionNotice, ProfileChampionBadges } from '../notice'

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ auth: { user: { id: 1 } } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: ComponentProps<'a'> & { to: string }) => (
    <a href={to} {...props} />
  ),
}))

let award: ChampionAward | null
let failSave: boolean
beforeEach(() => {
  failSave = false
  award = {
    id: 5,
    user_id: 1,
    username: 'recipient',
    spend: 500000,
    position: 3,
    reason: '',
    quota: 33300000,
    status: 'claimable',
    credited_at: 0,
    equipped: 3,
    read_at: 0,
    notice_seen_at: 0,
  }
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages') ? { items: [], total: 0 } : award,
    },
  }))
  vi.spyOn(api, 'put').mockImplementation(async (_url, body) => {
    if (failSave) return { data: { success: false, message: 'Save failed' } }
    const change = body as { decision?: string; seen?: boolean; read?: boolean }
    if (award && change.decision) {
      award = {
        ...award,
        status: change.decision === 'claim' ? 'credited' : 'declined',
        credited_at: change.decision === 'claim' ? 1794758403 : 0,
      }
    }
    if (award && change.seen) award = { ...award, notice_seen_at: 1794758403 }
    if (award && change.read) award = { ...award, read_at: 1794758403 }
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

test('winner badges link to the ranking with distinct accessible titles', async () => {
  setup(<ProfileChampionBadges />)
  const champion = await screen.findByRole('link', {
    name: 'Champion mid laner',
  })
  expect(champion).toHaveAttribute('href', '/championship')
  expect(
    screen.getByRole('link', { name: 'Championship commemorative badge' })
  ).toHaveAttribute('href', '/championship')
  expect(api.put).not.toHaveBeenCalled()
})
test('a memorial recipient has one profile badge even after giving up money', async () => {
  if (!award) throw new Error('Missing award fixture')
  award = { ...award, position: 9, status: 'declined', equipped: 8 }
  setup(<ProfileChampionBadges />)
  await screen.findByRole('link', { name: 'Championship commemorative badge' })
  expect(screen.getAllByRole('link')).toHaveLength(1)
})
test('an unfinished ranking does not grant a permanent profile badge', async () => {
  if (!award) throw new Error('Missing award fixture')
  award = { ...award, status: 'preview' }
  setup(<ProfileChampionBadges />)
  await waitFor(() => expect(api.get).toHaveBeenCalled())
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})
test('claiming explicitly credits the reward and retains the honor celebration', async () => {
  const { user } = setup(<ChampionNotice />)
  const dialog = await screen.findByRole('dialog', {
    name: 'Glory belongs to you',
  })
  expect(api.put).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole('button', { name: 'Claim reward' }))
  await screen.findByText(
    'Your activity reward has been credited to your personal balance. Your badges are yours permanently.'
  )
  expect(api.put).toHaveBeenCalledWith('/api/user/champion-event', {
    decision: 'claim',
  })
  expect(
    screen.queryByRole('button', { name: 'Claim reward' })
  ).not.toBeInTheDocument()
})
test('declining requires confirmation and canceling leaves the reward claimable', async () => {
  const { user } = setup(<ChampionNotice />)
  await user.click(
    await screen.findByRole('button', { name: 'Give up reward' })
  )
  const confirm = screen.getByRole('alertdialog')
  expect(within(confirm).getByText(/permanently give up/)).toHaveTextContent(
    '$66.6'
  )
  expect(api.put).not.toHaveBeenCalled()
  await user.click(within(confirm).getByRole('button', { name: 'Keep reward' }))
  expect(award?.status).toBe('claimable')
  expect(api.put).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Claim reward' })).toBeEnabled()
})
test('confirmed decline keeps the badges and removes the claim action', async () => {
  const { user } = setup(
    <>
      <ProfileChampionBadges />
      <ChampionNotice />
    </>
  )
  await user.click(
    await screen.findByRole('button', { name: 'Give up reward' })
  )
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Confirm giving up reward',
    })
  )
  await screen.findByText('Reward declined')
  expect(api.put).toHaveBeenCalledWith('/api/user/champion-event', {
    decision: 'decline',
    confirm_decline: true,
  })
  expect(award?.equipped).toBe(3)
  expect(
    screen.queryByRole('button', { name: 'Claim reward' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Got it' }))
  await screen.findByRole('link', { name: 'Champion mid laner' })
})
test('a failed claim leaves the reward claimable and offers retry', async () => {
  failSave = true
  const { user } = setup(<ChampionNotice />)
  await user.click(await screen.findByRole('button', { name: 'Claim reward' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Claim reward' })).toBeEnabled()
  )
  expect(award?.status).toBe('claimable')
})
test('closing the first login celebration persists dismissal but never declines money', async () => {
  const { user, view, client } = setup(
    <ChampionNotice>
      <p>Normal announcements</p>
    </ChampionNotice>
  )
  await screen.findByRole('dialog')
  expect(screen.queryByText('Normal announcements')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Decide later' }))
  await waitFor(() => expect(award?.notice_seen_at).toBeGreaterThan(0))
  expect(award?.status).toBe('claimable')
  expect(award?.read_at).toBe(0)
  await screen.findByText('Normal announcements')
  view.unmount()
  render(
    <QueryClientProvider client={client}>
      <ChampionNotice />
    </QueryClientProvider>
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
test('wallet reopens a deferred reward so it can be claimed later', async () => {
  if (!award) throw new Error('Missing award fixture')
  award = { ...award, notice_seen_at: 1794758403 }
  const { user } = setup(<ChampionHonors />)
  await user.click(await screen.findByRole('button', { name: 'Claim reward' }))
  await screen.findByRole('dialog', { name: 'Glory belongs to you' })
  expect(api.put).not.toHaveBeenCalled()
})
test('empty wallet does not show a permanent campaign management card', async () => {
  award = null
  setup(<ChampionHonors />)
  await waitFor(() => expect(api.get).toHaveBeenCalled())
  expect(
    screen.queryByText('Championship activity reward')
  ).not.toBeInTheDocument()
})
function ProfileBalance() {
  const { profile } = useProfile()
  return <output aria-label='Profile balance'>{profile?.quota}</output>
}
test('claiming from the login popup refreshes an already mounted profile balance', async () => {
  vi.mocked(api.get).mockImplementation(async (url) => {
    let data: unknown = award
    if (url === '/api/user/self') {
      data = { quota: award?.status === 'credited' ? 33300100 : 100 }
    }
    if (url.endsWith('/messages')) data = { items: [], total: 0 }
    return { data: { success: true, data } }
  })
  const { user } = setup(
    <>
      <ProfileBalance />
      <ChampionNotice />
    </>
  )
  await waitFor(() =>
    expect(screen.getByLabelText('Profile balance')).toHaveTextContent('100')
  )
  await user.click(await screen.findByRole('button', { name: 'Claim reward' }))
  await waitFor(() =>
    expect(screen.getByLabelText('Profile balance')).toHaveTextContent(
      '33300100'
    )
  )
})
test('compensation waits until the honor popup has been dismissed', async () => {
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
  await screen.findByRole('dialog', { name: 'Glory belongs to you' })
  expect(
    screen.queryByRole('dialog', { name: 'Stream compensation received' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Decide later' }))
  await screen.findByRole('dialog', { name: 'Stream compensation received' })
})
