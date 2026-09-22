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
import type * as React from 'react'

type Route = {
  id: string
  /** Path geometry in the 440×560 user space the field is drawn in. */
  d: string
  /** Seconds one pulse takes to travel the whole route. */
  duration: number
  /** Negative so every route is already mid-flight on first paint. */
  delay: number
  /**
   * Where the pulse parks when the visitor has asked for reduced motion, as a
   * stroke-dashoffset in the normalised 0–100 path length. The values differ
   * per route so the still frame reads as a composed diagram, not a stalled
   * animation.
   */
  rest: string
}

/** Upstream providers converging on this deployment. */
const INBOUND: Route[] = [
  {
    id: 'in-1',
    d: 'M -24 48 C 132 48, 176 280, 300 280',
    duration: 7.5,
    delay: -1.2,
    rest: '38',
  },
  {
    id: 'in-2',
    d: 'M -24 164 C 124 164, 192 280, 300 280',
    duration: 9.5,
    delay: -6.4,
    rest: '61',
  },
  {
    id: 'in-3',
    d: 'M -24 280 L 300 280',
    duration: 6,
    delay: -3.1,
    rest: '17',
  },
  {
    id: 'in-4',
    d: 'M -24 396 C 124 396, 192 280, 300 280',
    duration: 8.5,
    delay: -4.7,
    rest: '74',
  },
  {
    id: 'in-5',
    d: 'M -24 512 C 132 512, 176 280, 300 280',
    duration: 11,
    delay: -8.3,
    rest: '46',
  },
]

/** The single OpenAI-compatible route back out to the caller. */
const OUTBOUND: Route = {
  id: 'out',
  d: 'M 300 280 L 464 280',
  duration: 3.4,
  delay: -0.6,
  rest: '29',
}

const ROUTES = [...INBOUND, OUTBOUND]

function pulseStyle(route: Route): React.CSSProperties {
  return {
    animationDuration: `${route.duration}s`,
    animationDelay: `${route.delay}s`,
    '--auth-route-rest': route.rest,
  } as React.CSSProperties
}

/**
 * The one moving idea on the auth screens: every upstream provider funnels into
 * this deployment and leaves again on a single endpoint. Purely decorative, so
 * the layer is hidden from assistive technology and never takes pointer events.
 */
export function AuthBackdrop() {
  return (
    <div
      aria-hidden='true'
      className='pointer-events-none absolute inset-0 overflow-hidden'
    >
      <svg
        className='auth-route-field absolute inset-0 h-full w-full'
        viewBox='0 0 440 560'
        preserveAspectRatio='xMidYMid slice'
        focusable='false'
      >
        {ROUTES.map((route) => (
          <path
            key={route.id}
            className='auth-route'
            d={route.d}
            pathLength='100'
          />
        ))}

        {ROUTES.map((route) => (
          <path
            key={route.id}
            className={
              route.id === OUTBOUND.id
                ? 'auth-route-pulse auth-route-pulse-out'
                : 'auth-route-pulse'
            }
            d={route.d}
            pathLength='100'
            style={pulseStyle(route)}
          />
        ))}

        <circle className='auth-node-halo' cx='300' cy='280' r='52' />
        <circle className='auth-node-ring' cx='300' cy='280' r='21' />
        <circle className='auth-node' cx='300' cy='280' r='7' />
      </svg>
    </div>
  )
}
