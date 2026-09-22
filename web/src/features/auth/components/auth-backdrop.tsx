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

/** Horizontal request lanes, as a percentage of the viewport height. */
const LANES = [11, 20, 28, 37, 45, 54, 62, 71, 79, 88]

/**
 * Traffic on the lanes. `rest` is where a packet parks when the visitor has
 * asked for reduced motion — the lane field then reads as a static topology
 * diagram instead of a frozen animation.
 */
const PACKETS = [
  { top: 11, duration: 21, delay: -3, rest: '24vw' },
  { top: 20, duration: 16, delay: -11, rest: '67vw' },
  { top: 37, duration: 26, delay: -6, rest: '41vw' },
  { top: 45, duration: 13, delay: -1, rest: '82vw' },
  { top: 62, duration: 19, delay: -14, rest: '15vw' },
  { top: 71, duration: 24, delay: -8, rest: '55vw' },
  { top: 88, duration: 17, delay: -5, rest: '73vw' },
]

/**
 * The one moving idea on the auth screens: requests travel along lanes, cross
 * the gate column that stands for this deployment, and carry on out the other
 * side. Everything is decorative, so the whole layer is hidden from assistive
 * technology and never takes pointer events.
 */
export function AuthBackdrop() {
  return (
    <div
      aria-hidden='true'
      className='pointer-events-none absolute inset-0 overflow-hidden'
    >
      <svg
        className='auth-lane-field absolute inset-0 h-full w-full'
        viewBox='0 0 100 100'
        preserveAspectRatio='none'
      >
        {LANES.map((y) => (
          <line
            key={y}
            className='auth-lane'
            x1='0'
            y1={y}
            x2='100'
            y2={y}
            strokeWidth='1'
            vectorEffect='non-scaling-stroke'
          />
        ))}
      </svg>

      {PACKETS.map((packet) => (
        <span
          key={packet.top}
          className='auth-packet'
          style={
            {
              top: `${packet.top}%`,
              animationDuration: `${packet.duration}s`,
              animationDelay: `${packet.delay}s`,
              '--auth-packet-rest': packet.rest,
            } as React.CSSProperties
          }
        >
          <span className='auth-packet-head' />
        </span>
      ))}

      {/* The gate: a soft band with a hairline at its centre, sitting on the
       * seam between the brand column and the form panel (1fr / 1.3fr). */}
      <div className='auth-gate-band auth-gate-pulse absolute inset-y-0 hidden lg:block' />
      <div className='auth-gate-line absolute inset-y-0 hidden lg:block' />

      <div className='auth-backdrop-vignette absolute inset-0' />
    </div>
  )
}
