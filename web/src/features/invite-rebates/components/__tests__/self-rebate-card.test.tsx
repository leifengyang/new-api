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
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import type { InviteRebate, SelfInviteRebatesData } from '../../types'
import { SelfRebateCard } from '../self-rebate-card'

// The locale bundle is intentionally empty, so every t('...') resolves to its
// own English key — interpolated with the values the component passes in.
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

const INTERNAL = 1
const EXTERNAL = 0

function makeRebate(overrides: Partial<InviteRebate> = {}): InviteRebate {
  return {
    id: 7,
    inviter_id: 2,
    inviter_name: 'alice',
    // 后端已经脱敏，前端拿到的就是这个名字。
    invitee_id: 3,
    invitee_name: 'b***b',
    source: 'epay',
    source_ref: 'trade-1',
    base_quota: 5000000,
    rate_basis_points: 1000,
    // 默认额度单位下 500000 折合 1 美元，断言的金额才稳定。
    rebate_quota: 500000,
    outstanding_quota: 500000,
    status: 'credited',
    skip_reason: '',
    reversed_quota: 0,
    reversed_at: 0,
    reversed_by: 0,
    reverse_reason: '',
    created_at: 1700000000,
    ...overrides,
  }
}

function makeSelfData(
  overrides: Partial<SelfInviteRebatesData> = {}
): SelfInviteRebatesData {
  const items = overrides.page?.items ?? [makeRebate()]
  return {
    page: { items, total: items.length, page: 1, page_size: 20 },
    summary: {
      total_quota: 500000,
      reversed_quota: 0,
      rebate_count: items.length,
    },
    rate_basis_points: 1000,
    rebate_enabled: true,
    member_level: INTERNAL,
    rebate_available: true,
    ...overrides,
  }
}

const clients: QueryClient[] = []

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

function renderCard(data: SelfInviteRebatesData) {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data },
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SelfRebateCard
          affiliateLink='https://example.com/sign-up?aff=abc'
          inviteCount={4}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
  return get
}

it('summarises the rebates of an internal member and lists the masked downline', async () => {
  const get = renderCard(makeSelfData())
  const user = userEvent.setup()

  expect(await screen.findByText('Internal Member')).toBeInTheDocument()
  // 内部学员的每笔充值都返，与外部学员的首充口径区分开。
  expect(
    screen.getByText(
      'You earn 10% of every top-up made by the members you invited.'
    )
  ).toBeInTheDocument()
  // 累计返现、返现笔数、邀请人数。
  expect(screen.getByText('Total Earned')).toBeInTheDocument()
  expect(screen.getByText('Rebates').nextElementSibling).toHaveTextContent('1')
  expect(screen.getByText('Invites').nextElementSibling).toHaveTextContent('4')
  expect(
    screen.getByDisplayValue('https://example.com/sign-up?aff=abc')
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Details' }))

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('b***b')).toBeInTheDocument()
  expect(within(dialog).getByText('+$1')).toBeInTheDocument()
  expect(
    within(dialog).getByText(
      'Every rebate credited for a top-up made by someone you invited.'
    )
  ).toBeInTheDocument()

  await waitFor(() => {
    const selfUrl = get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/api/invite_rebate/self'))
    expect(selfUrl).toBeDefined()
    expect(selfUrl).toContain('page_size=20')
  })
})

it('tells an external member they only earn on each invitee first top-up', async () => {
  renderCard(
    makeSelfData({
      member_level: EXTERNAL,
      summary: { total_quota: 0, reversed_quota: 0, rebate_count: 0 },
      page: { items: [], total: 0, page: 1, page_size: 20 },
    })
  )

  expect(
    await screen.findByText(
      'You earn 10% of the first top-up made by each member you invite. Internal members earn it on every top-up.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByText('Internal Member')).not.toBeInTheDocument()
  // 没有明细可看时不显示入口。
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
})

it('tells an administrator no top-up of theirs earns a rebate', async () => {
  renderCard(
    makeSelfData({
      member_level: EXTERNAL,
      rebate_available: false,
      summary: { total_quota: 0, reversed_quota: 0, rebate_count: 0 },
      page: { items: [], total: 0, page: 1, page_size: 20 },
    })
  )

  expect(
    await screen.findByText('Administrators do not earn invite rebates.')
  ).toBeInTheDocument()
})

it('reports a switched-off programme instead of the rate of an eligible member', async () => {
  renderCard(
    makeSelfData({
      rebate_enabled: false,
      summary: { total_quota: 0, reversed_quota: 0, rebate_count: 0 },
      page: { items: [], total: 0, page: 1, page_size: 20 },
    })
  )

  expect(
    await screen.findByText('Invite rebates are currently disabled.')
  ).toBeInTheDocument()
})
