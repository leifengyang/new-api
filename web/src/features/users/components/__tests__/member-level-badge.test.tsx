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
import { cleanup, render } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, expect, it } from 'vitest'

import { MemberLevelBadge } from '../member-level-badge'

// 与 member-level.test.tsx 一致：空语言包让 t('...') 退回英文键本身，
// 断言就不会绑定到某种语言的完整文案上。
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

const EXTERNAL = 0
const INTERNAL = 1

afterEach(cleanup)

function renderBadge(level: number) {
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <MemberLevelBadge level={level} />
    </I18nextProvider>
  )
  return container.querySelector('[data-slot="status-badge"]')
}

it('marks an internal member with the black-and-gold badge and a crown', () => {
  const badge = renderBadge(INTERNAL)

  expect(badge).toHaveTextContent('Internal Member')
  // 黑金是这个身份唯一的视觉区分，底色和字色各断言一个特征类，
  // 不去比对整串 class。
  expect(badge).toHaveClass('bg-neutral-900', 'text-amber-300')
  expect(badge?.querySelector('svg.lucide-crown')).toHaveAttribute(
    'aria-hidden',
    'true'
  )
})

it('leaves an external user on the plain badge without the crown', () => {
  const badge = renderBadge(EXTERNAL)

  expect(badge).toHaveTextContent('External')
  expect(badge).not.toHaveClass('bg-neutral-900')
  expect(badge?.querySelector('svg.lucide-crown')).toBeNull()
})

it('renders nothing for a level the backend does not define yet', () => {
  expect(renderBadge(2)).toBeNull()
})
