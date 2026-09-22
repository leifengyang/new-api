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
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AuthBackdrop } from '../auth-backdrop'

describe('auth backdrop', () => {
  it('hides the whole decorative field from assistive technology', () => {
    const { container } = render(<AuthBackdrop />)

    const lanes = container.querySelector('svg')

    expect(lanes?.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('keeps the field out of the tab order by rendering no interactive nodes', () => {
    const { container } = render(<AuthBackdrop />)

    expect(
      container.querySelectorAll('a, button, input, [tabindex]')
    ).toHaveLength(0)
  })

  it('gives every packet a resting offset so reduced motion parks them apart', () => {
    const { container } = render(<AuthBackdrop />)

    const packets = [...container.querySelectorAll<HTMLElement>('.auth-packet')]

    expect(packets.length).toBeGreaterThan(0)
    const restingOffsets = packets.map((packet) =>
      packet.style.getPropertyValue('--auth-packet-rest')
    )
    expect(restingOffsets.every(Boolean)).toBe(true)
    expect(new Set(restingOffsets).size).toBe(packets.length)
  })

  it('staggers packet timing so they never travel as one block', () => {
    const { container } = render(<AuthBackdrop />)

    const durations = [
      ...container.querySelectorAll<HTMLElement>('.auth-packet'),
    ].map((packet) => packet.style.animationDuration)

    expect(new Set(durations).size).toBeGreaterThan(1)
  })
})
