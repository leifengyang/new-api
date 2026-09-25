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
import type { DistrictId } from './town-data'

const GLYPHS: Record<DistrictId, string> = {
  core: 'M12 2 14.8 8.8 22 12 14.8 15.2 12 22 9.2 15.2 2 12 9.2 8.8Z',
  language: 'M5 5h14v11H9l-4 4V5Zm4 4h6m-6 3h4',
  vision: 'm12 2 9 16H3L12 2Zm0 0v20m-9-4 9 4 9-4',
  audio: 'M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4',
  memory: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
}

export function TownGlyph(props: { district: DistrictId; className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.35'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={props.className}
    >
      <path d={GLYPHS[props.district]} />
    </svg>
  )
}
