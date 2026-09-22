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
import { cn } from '@/lib/utils'

/**
 * The gateway motif behind the auth screens: many request strands entering
 * from the edge, converging on a single node that sits exactly on the seam
 * the sign-in form lives behind. Paths are stretched with
 * `preserveAspectRatio="none"`, so strokes keep their hairline weight through
 * `vector-effect="non-scaling-stroke"` and the node is drawn in HTML to stay
 * perfectly round at any panel proportion.
 */
const STRANDS = [
  { d: 'M0 6 C 140 6 196 160 400 160', opacity: 0.1, delay: 0 },
  { d: 'M0 58 C 152 58 208 160 400 160', opacity: 0.16, delay: 70 },
  { d: 'M0 109 C 174 109 228 160 400 160', opacity: 0.24, delay: 140 },
  { d: 'M0 160 H 400', opacity: 0.32, delay: 210 },
  { d: 'M0 211 C 174 211 228 160 400 160', opacity: 0.24, delay: 140 },
  { d: 'M0 262 C 152 262 208 160 400 160', opacity: 0.16, delay: 70 },
  { d: 'M0 314 C 140 314 196 160 400 160', opacity: 0.1, delay: 0 },
]

function GateNode(props: { className?: string }) {
  return (
    <span className={cn('absolute block', props.className)}>
      <span className='auth-gate-node bg-primary ring-primary/20 block size-2.5 rounded-full ring-6' />
    </span>
  )
}

export function AuthGate(props: { className?: string }) {
  return (
    <div
      aria-hidden='true'
      className={cn('pointer-events-none absolute inset-0', props.className)}
    >
      {/* Wide screens: strands converge on the seam between panel and form. */}
      <div className='absolute inset-0 hidden lg:block'>
        <svg
          viewBox='0 0 400 320'
          preserveAspectRatio='none'
          className='text-foreground absolute inset-0 h-full w-full'
        >
          {STRANDS.map((strand) => (
            <path
              key={strand.d}
              className='auth-gate-strand'
              d={strand.d}
              pathLength={1}
              fill='none'
              stroke='currentColor'
              strokeWidth={1}
              strokeOpacity={strand.opacity}
              vectorEffect='non-scaling-stroke'
              style={{ '--auth-gate-delay': `${strand.delay}ms` } as React.CSSProperties}
            />
          ))}
        </svg>
        <span
          className='absolute inset-y-0 right-0 w-px'
          style={{
            background:
              'linear-gradient(to bottom, var(--border) 0%, var(--border) 26%, var(--primary) 50%, var(--border) 74%, var(--border) 100%)',
          }}
        />
        <GateNode className='top-1/2 right-0 -translate-y-1/2 translate-x-1/2' />
      </div>

      {/* Narrow screens: the seam lies flat under the header, node on the end. */}
      <div className='absolute inset-x-0 bottom-0 lg:hidden'>
        <span
          className='absolute inset-x-0 bottom-0 h-px'
          style={{
            background:
              'linear-gradient(to right, var(--border) 0%, var(--border) 52%, var(--primary) 88%, var(--primary) 100%)',
          }}
        />
        <GateNode className='right-6 bottom-0 translate-y-1/2 sm:right-10' />
      </div>
    </div>
  )
}
