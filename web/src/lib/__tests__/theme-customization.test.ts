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
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THEME_CUSTOMIZATION,
  resolveThemeFont,
  THEME_PRESETS,
} from '../theme-customization'

describe('resolveThemeFont', () => {
  it('resolves the out-of-the-box preference to the editorial serif', () => {
    const font = resolveThemeFont(
      DEFAULT_THEME_CUSTOMIZATION.font,
      DEFAULT_THEME_CUSTOMIZATION.preset
    )

    expect(font).toBe('serif')
  })

  it('keeps an explicit sans choice on the default preset', () => {
    expect(resolveThemeFont('sans', 'default')).toBe('sans')
  })

  it('keeps an explicit serif choice on a preset that defaults to sans', () => {
    expect(resolveThemeFont('serif', 'rose-garden')).toBe('serif')
  })

  it('falls back to sans for a preset that declares no typography', () => {
    expect(resolveThemeFont('default', 'rose-garden')).toBe('sans')
  })
})

describe('THEME_PRESETS', () => {
  it('lists the default preset first so the picker opens on it', () => {
    expect(THEME_PRESETS[0].value).toBe('default')
  })

  it('gives every preset two swatches for the picker chip gradient', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.swatches).toHaveLength(2)
      expect(preset.swatches[0]).not.toBe(preset.swatches[1])
    }
  })
})
