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
    leg: 'direct',
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
      frozen_quota: 0,
    },
    rate_basis_points: 1000,
    external_rate_basis_points: 100,
    internal_referrer_rate_basis_points: 100,
    rebate_enabled: true,
    member_level: INTERNAL,
    // 默认已通过审核，冻结相关的断言才能单独测。没有冻结时这张卡和以前一样。
    rebate_review_status: 'approved',
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
  // 内部学员两条腿都拿：自己直属下线的充值走 ①，下线再带来的用户走 ③。
  expect(
    screen.getByText(
      'You earn 10% of every top-up made by the members you invited, plus 1% of every top-up made by the members they invite.'
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
      'Every rebate credited to you, and the top-up it came from.'
    )
  ).toBeInTheDocument()
  // 内部学员看到的那条腿是直属下线带来的。
  expect(within(dialog).getByText('Direct invitee')).toBeInTheDocument()

  await waitFor(() => {
    const selfUrl = get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/api/invite_rebate/self'))
    expect(selfUrl).toBeDefined()
    expect(selfUrl).toContain('page_size=20')
  })
})

it('tells an external member only their own rule, never the internal one', async () => {
  renderCard(
    makeSelfData({
      member_level: EXTERNAL,
      summary: {
        total_quota: 0,
        reversed_quota: 0,
        rebate_count: 0,
        frozen_quota: 0,
      },
      page: { items: [], total: 0, page: 1, page_size: 20 },
    })
  )

  // 外部用户拿的是比例②，不是内部学员的 ①。
  expect(
    await screen.findByText(
      'You earn 1% of every top-up made by the members you invited.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByText('Internal Member')).not.toBeInTheDocument()
  // 外部用户不该知道内部会员还能多拿一条腿。
  expect(
    screen.queryByText(
      /plus .* of every top-up made by the members they invite/i
    )
  ).toBeNull()
  // 没有明细可看时不显示入口。
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
})

it('tells an administrator no top-up of theirs earns a rebate', async () => {
  renderCard(
    makeSelfData({
      member_level: EXTERNAL,
      rebate_available: false,
      summary: {
        total_quota: 0,
        reversed_quota: 0,
        rebate_count: 0,
        frozen_quota: 0,
      },
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
      summary: {
        total_quota: 0,
        reversed_quota: 0,
        rebate_count: 0,
        frozen_quota: 0,
      },
      page: { items: [], total: 0, page: 1, page_size: 20 },
    })
  )

  expect(
    await screen.findByText('Invite rebates are currently disabled.')
  ).toBeInTheDocument()
})

it('shows an unapproved internal member what is frozen instead of the rates', async () => {
  renderCard(
    makeSelfData({
      rebate_review_status: 'pending',
      summary: {
        total_quota: 0,
        reversed_quota: 0,
        // 钱已经在账本里算出来了，只是没进余额。
        rebate_count: 1,
        frozen_quota: 500000,
      },
      page: {
        items: [makeRebate({ status: 'frozen' })],
        total: 1,
        page: 1,
        page_size: 20,
      },
    })
  )

  // 冻结比比例更要紧，说明那一行要盖掉原来的口径介绍。
  expect(
    await screen.findByText(
      'Rebates are credited once your review has passed. Until then they stay frozen.'
    )
  ).toBeInTheDocument()
  // 累计返现只算已入账的，冻结的单独占一格。
  expect(screen.getByText('Total Earned').nextElementSibling).toHaveTextContent(
    '$0'
  )
  expect(screen.getByText('Frozen').nextElementSibling).toHaveTextContent('$1')
})

it('keeps the frozen stat out of the way once the review has passed', async () => {
  renderCard(makeSelfData())

  expect(await screen.findByText('Internal Member')).toBeInTheDocument()
  expect(screen.queryByText('Frozen')).toBeNull()
})

it('lets an unapproved member open the ledger to see the frozen row', async () => {
  const user = userEvent.setup()
  renderCard(
    makeSelfData({
      rebate_review_status: 'rejected',
      summary: {
        total_quota: 0,
        reversed_quota: 0,
        rebate_count: 1,
        frozen_quota: 500000,
      },
      page: {
        items: [makeRebate({ status: 'frozen' })],
        total: 1,
        page: 1,
        page_size: 20,
      },
    })
  )

  // 未通过和未审核对钱的效果一样，明细入口照样要有——否则学员看不到这笔钱。
  await user.click(await screen.findByRole('button', { name: 'Details' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Frozen')).toBeInTheDocument()
})
