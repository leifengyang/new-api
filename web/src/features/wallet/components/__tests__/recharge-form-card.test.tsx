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
import { cleanup, render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'

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

afterEach(cleanup)

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
  render(
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

it('keeps the external channel clickable when the amount is below the gateway minimum', () => {
  renderCard({
    topupInfo: makeTopupInfo(),
    topupLink: CHANNEL_URL,
    topupAmount: 1,
  })

  // 金额在店里选，所以网关的最低金额限制不该传染给外部渠道。
  expect(screen.getByRole('button', { name: /Alipay/ })).toBeDisabled()
  expect(getChannel()).toBeEnabled()
})

it('shows the external channel when no gateway method is configured at all', () => {
  renderCard({
    topupInfo: makeTopupInfo({
      enable_online_topup: false,
      enable_stripe_topup: false,
      pay_methods: [],
    }),
    topupLink: CHANNEL_URL,
  })

  getChannel()
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
