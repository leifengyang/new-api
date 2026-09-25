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
import { useId } from 'react'

/** An original vector landscape remains visible while WebGL loads or is unavailable. */
export function TownBackdrop() {
  const id = useId().replaceAll(':', '')
  return (
    <svg
      className='town-backdrop'
      viewBox='0 0 1200 650'
      fill='none'
      aria-hidden='true'
    >
      <defs>
        <radialGradient id={`${id}halo`}>
          <stop stopColor='#9b83ff' stopOpacity='.23' />
          <stop offset='1' stopColor='#9b83ff' stopOpacity='0' />
        </radialGradient>
        <linearGradient id={`${id}island`} x1='0' y1='0' x2='1' y2='1'>
          <stop stopColor='#827eb5' />
          <stop offset='1' stopColor='#25284b' />
        </linearGradient>
        <linearGradient id={`${id}crystal`} x1='0' y1='0' x2='1' y2='1'>
          <stop stopColor='#bff8ee' />
          <stop offset='.5' stopColor='#ab9bed' />
          <stop offset='1' stopColor='#524599' />
        </linearGradient>
      </defs>
      <ellipse cx='600' cy='340' rx='530' ry='300' fill={`url(#${id}halo)`} />
      <g stroke='#9995dc' strokeOpacity='.24'>
        <ellipse cx='600' cy='370' rx='430' ry='160' strokeDasharray='3 14' />
        <ellipse cx='600' cy='370' rx='345' ry='128' />
        <path d='M290 395Q470 300 600 365T955 385M600 365Q550 300 535 240M600 365Q745 300 810 270' />
      </g>
      {[
        { x: 600, y: 355, s: 1.4 },
        { x: 285, y: 390, s: 0.82 },
        { x: 825, y: 270, s: 0.9 },
        { x: 950, y: 445, s: 0.75 },
        { x: 510, y: 215, s: 0.62 },
      ].map((island) => (
        <g
          key={island.x}
          transform={`translate(${island.x} ${island.y}) scale(${island.s})`}
        >
          <path d='m-95 0 95-43L95 0 40 68-36 60Z' fill={`url(#${id}island)`} />
          <path
            d='m-95 0 95-43L95 0 0 43Z'
            fill='#6d709b'
            stroke='#c8c0f4'
            strokeOpacity='.55'
          />
          <ellipse cy='-8' rx='63' ry='26' stroke='#b7b0f3' />
          <path
            d='M0-133 29-55 0-19-29-55Z'
            fill={`url(#${id}crystal)`}
            stroke='#d0c7ff'
          />
          <path d='M0-133v114L29-55Z' fill='#b9b2ed' fillOpacity='.35' />
          <ellipse
            cy='-52'
            rx='48'
            ry='15'
            stroke='#cab6ff'
            transform='rotate(-20)'
          />
        </g>
      ))}
      {Array.from({ length: 35 }, (_, i) => (
        <circle
          key={i}
          cx={70 + ((i * 173) % 1050)}
          cy={65 + ((i * 73) % 480)}
          r={i % 3 === 0 ? 1.8 : 0.8}
          fill='#c9c0ed'
          opacity={0.2 + (i % 4) * 0.15}
        />
      ))}
    </svg>
  )
}
