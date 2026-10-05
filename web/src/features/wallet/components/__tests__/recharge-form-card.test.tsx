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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { TopupInfo } from '../../types'
import { RechargeFormCard } from '../recharge-form-card'

// 空语言包：t('...') 原样返回 key，断言里用的就是英文原文。
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

const CHANNEL_URL = 'https://catfk.com/shop/DLAZ9MW9'

it('isolates reminder state when the account changes during a save', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { shown_count: 0, show_guide: true } },
  })
  let finishFirst!: (value: unknown) => void
  vi.spyOn(api, 'post')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        })
    )
    .mockResolvedValue({
      data: { success: true, data: { shown_count: 1, show_guide: true } },
    })
  const user = userEvent.setup()
  renderCard({ topupInfo: makeTopupInfo(), topupLink: CHANNEL_URL })
  await waitFor(() => expect(getChannel()).toBeEnabled())
  await user.click(getChannel())
  await waitFor(() => expect(api.post).toHaveBeenCalledOnce())
  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 2, username: 'second-user', role: 1 })
  )
  await act(async () =>
    finishFirst({
      data: { success: true, data: { shown_count: 3, show_guide: true } },
    })
  )
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(getChannel()).toBeEnabled())
  await user.click(getChannel())
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
})

const clients: QueryClient[] = []
beforeEach(() => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'guide-user', role: 1 })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: { shown_count: 3, show_guide: false } },
  })
})
afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients.length = 0
  useAuthStore.getState().auth.setUser(null)
})

// Button 的 render 会把 role="button" 一并交给渲染出来的 <a>（和概览页
// api-info-item 的外链同一个写法），所以这里按 aria-label 取，再自己确认它
// 确实是个带 href 的锚点。
function getChannel(): HTMLElement {
  const element = screen.getByLabelText('Online Topup')
  expect(element.tagName).toBe('A')
  return element
}

function makeTopupInfo(overrides: Partial<TopupInfo> = {}): TopupInfo {
  return {
    enable_online_topup: true,
    enable_stripe_topup: false,
    pay_methods: [{ name: 'Alipay', type: 'alipay', min_topup: 10 }],
    min_topup: 10,
    stripe_min_topup: 10,
    amount_options: [],
    discount: {},
    enable_redemption: true,
    ...overrides,
  }
}

function renderCard(options: {
  topupInfo: TopupInfo
  topupLink?: string
  topupAmount?: number
}) {
  const onPaymentMethodSelect = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <RechargeFormCard
          topupInfo={options.topupInfo}
          presetAmounts={[]}
          selectedPreset={null}
          onSelectPreset={vi.fn()}
          topupAmount={options.topupAmount ?? 50}
          onTopupAmountChange={vi.fn()}
          paymentAmount={50}
          calculating={false}
          onPaymentMethodSelect={onPaymentMethodSelect}
          paymentLoading={null}
          redemptionCode=''
          onRedemptionCodeChange={vi.fn()}
          onRedeem={vi.fn()}
          redeeming={false}
          topupLink={options.topupLink}
        />
      </I18nextProvider>
    </QueryClientProvider>
  )
  return { onPaymentMethodSelect }
}

it('renders the external channel next to the gateway methods as a new-tab link', () => {
  renderCard({ topupInfo: makeTopupInfo(), topupLink: CHANNEL_URL })

  const link = getChannel()
  expect(link).toHaveAttribute('href', CHANNEL_URL)
  // 新窗口打开，并且不能把 referrer / opener 交给对方站点。
  expect(link).toHaveAttribute('target', '_blank')
  expect(link.getAttribute('rel')).toContain('noopener')
  expect(screen.getByText('Buy a code, then redeem below')).toBeInTheDocument()

  // 和支付宝并列：网关渠道是按钮，外部渠道是链接。
  expect(screen.getByRole('button', { name: 'Alipay' })).toBeInTheDocument()
})

it('keeps the external channel clickable when the amount is below the gateway minimum', async () => {
  renderCard({
    topupInfo: makeTopupInfo(),
    topupLink: CHANNEL_URL,
    topupAmount: 1,
  })

  // 金额在店里选，所以网关的最低金额限制不该传染给外部渠道。
  expect(screen.getByRole('button', { name: /Alipay/ })).toBeDisabled()
  await waitFor(() => expect(getChannel()).toBeEnabled())
})

it('shows only the external channel when no gateway is actually switched on', () => {
  renderCard({
    topupInfo: makeTopupInfo({
      // 服务端在没配网关时照样返回这份默认列表，它不是「可用」的证据。
      enable_online_topup: false,
      enable_stripe_topup: false,
      pay_methods: [
        { name: '支付宝', type: 'alipay' },
        { name: '微信', type: 'wxpay' },
        { name: '自定义1', type: 'custom1', min_topup: 50 },
      ],
    }),
    topupLink: CHANNEL_URL,
  })

  expect(getChannel()).toBeInTheDocument()
  // 一个网关都没接，就不该摆出一排点了没反应的支付宝/微信。
  expect(
    screen.queryByRole('button', { name: /支付宝|微信|Alipay/ })
  ).toBeNull()
  // 只挂了发卡站时，金额在店里选，平台这边的金额输入框也不该出现。
  expect(screen.queryByLabelText('Custom Amount')).toBeNull()

  // 渠道那一排还在，就不该再报「没有任何可用支付方式」。
  expect(
    screen.queryByText(
      'No payment methods available. Please contact administrator.'
    )
  ).not.toBeInTheDocument()
  expect(
    screen.queryByText(
      'Online topup is not enabled. Please use redemption code or contact administrator.'
    )
  ).not.toBeInTheDocument()
})

it('renders no channel when the link is missing, blank or not http(s)', () => {
  for (const topupLink of [
    undefined,
    '',
    '   ',
    // 非 http(s) 的协议会被当成按钮点出去，相对路径则会把人带回平台自己
    // 的页面 —— 两者都当作「后台没配」。
    'javascript:alert(1)',
    '/wallet',
    'catfk.com/shop/DLAZ9MW9',
  ]) {
    renderCard({ topupInfo: makeTopupInfo(), topupLink })
    expect(screen.queryByLabelText('Online Topup')).toBeNull()
    cleanup()
  }
})

it('shows the three payment steps before navigation and keeps reminding after dismissal until three views', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { shown_count: 0, show_guide: true } },
  })
  let count = 0
  const post = vi.spyOn(api, 'post').mockImplementation(async () => ({
    data: { success: true, data: { shown_count: ++count, show_guide: true } },
  }))
  const user = userEvent.setup()
  renderCard({ topupInfo: makeTopupInfo(), topupLink: CHANNEL_URL })
  await waitFor(() => expect(getChannel()).toBeEnabled())
  for (let view = 1; view <= 3; view++) {
    await user.click(getChannel())
    expect(
      await screen.findByRole('dialog', { name: 'Read before paying' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('Payment alone does not credit your balance')
    ).toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(3)
    const proceed = screen.getByRole('button', {
      name: 'Got it, continue to payment',
    })
    expect(proceed).toHaveAttribute('href', CHANNEL_URL)
    expect(proceed).toHaveAttribute('rel', 'noopener noreferrer')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(view))
    await user.click(screen.getByRole('button', { name: 'Close for now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(getChannel()).toBeEnabled())
  }
  // Observe the default link action without actually navigating in jsdom.
  let wasPrevented = true
  const stopNavigation = (event: MouseEvent) => {
    wasPrevented = event.defaultPrevented
    event.preventDefault()
  }
  document.addEventListener('click', stopNavigation)
  await user.click(getChannel())
  document.removeEventListener('click', stopNavigation)
  expect(wasPrevented).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(post).toHaveBeenCalledTimes(3)
})

it('does not consume reminders just by opening the wallet or clicking a gateway payment method', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { shown_count: 0, show_guide: true } },
  })
  const post = vi.spyOn(api, 'post')
  const user = userEvent.setup()
  const { onPaymentMethodSelect } = renderCard({
    topupInfo: makeTopupInfo(),
    topupLink: CHANNEL_URL,
  })
  await waitFor(() => expect(getChannel()).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Alipay' }))
  expect(onPaymentMethodSelect).toHaveBeenCalledOnce()
  expect(post).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the guide readable and the payment link available when saving the view fails', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { shown_count: 0, show_guide: true } },
  })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'Unable to save reminder' },
  })
  const user = userEvent.setup()
  renderCard({ topupInfo: makeTopupInfo(), topupLink: CHANNEL_URL })
  await waitFor(() => expect(getChannel()).toBeEnabled())
  await user.click(getChannel())
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Got it, continue to payment' })
  ).toHaveAttribute('href', CHANNEL_URL)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(getChannel()).toBeEnabled())
  await user.click(getChannel())
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})
