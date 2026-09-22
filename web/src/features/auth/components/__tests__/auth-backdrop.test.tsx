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

    expect(
      container.querySelector('svg')?.closest('[aria-hidden="true"]')
    ).not.toBeNull()
  })

  it('keeps the field out of the tab order by rendering no interactive nodes', () => {
    const { container } = render(<AuthBackdrop />)

    expect(
      container.querySelectorAll('a, button, input, [tabindex]')
    ).toHaveLength(0)
  })

  it('draws a faint base stroke for every route that carries a pulse', () => {
    const { container } = render(<AuthBackdrop />)

    const routes = container.querySelectorAll('.auth-route')
    const pulses = container.querySelectorAll('.auth-route-pulse')

    expect(routes.length).toBeGreaterThan(1)
    expect(pulses).toHaveLength(routes.length)
  })

  it('normalises every route so one dash spans the same share of each path', () => {
    const { container } = render(<AuthBackdrop />)

    const lengths = [...container.querySelectorAll('.auth-route-pulse')].map(
      (pulse) => pulse.getAttribute('pathLength')
    )

    expect(lengths.length).toBeGreaterThan(0)
    expect(lengths.every((length) => length === '100')).toBe(true)
  })

  it('parks each pulse at its own offset so reduced motion still reads as a diagram', () => {
    const { container } = render(<AuthBackdrop />)

    const parked = [
      ...container.querySelectorAll<SVGPathElement>('.auth-route-pulse'),
    ].map((pulse) => pulse.style.getPropertyValue('--auth-route-rest'))

    expect(parked.length).toBeGreaterThan(0)
    expect(parked.every(Boolean)).toBe(true)
    expect(new Set(parked).size).toBe(parked.length)
  })

  it('staggers pulse timing so the routes never travel as one block', () => {
    const { container } = render(<AuthBackdrop />)

    const durations = [
      ...container.querySelectorAll<SVGPathElement>('.auth-route-pulse'),
    ].map((pulse) => pulse.style.animationDuration)

    expect(new Set(durations).size).toBeGreaterThan(1)
  })

  it('marks the single outbound route apart from the inbound ones', () => {
    const { container } = render(<AuthBackdrop />)

    expect(container.querySelectorAll('.auth-route-pulse-out')).toHaveLength(1)
  })
})
