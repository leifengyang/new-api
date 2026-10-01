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
import { describe, expect, test } from 'vitest'

import { getLogTokenUsage } from '../token-usage'

describe('log token accounting', () => {
  test('OpenAI totals split cache without counting it twice', () => {
    expect(getLogTokenUsage(97598, 77, { cache_tokens: 97280 })).toMatchObject({
      input: 318,
      totalInput: 97598,
      total: 97675,
      cacheRead: 97280,
    })
  })
  test('Anthropic separate counters produce the same input total', () => {
    const result = getLogTokenUsage(318, 77, {
      usage_semantic: 'anthropic',
      cache_tokens: 97280,
    })
    expect(result.total).toBe(97675)
    expect(result.hitRate).toBeCloseTo(99.674, 3)
  })
  test('explicit normalized totals take precedence over request format', () => {
    expect(
      getLogTokenUsage(318, 77, {
        input_tokens_total: 97598,
        claude: true,
        cache_tokens: 97280,
      }).input
    ).toBe(318)
  })
  test('cache writes use normalized totals and are not cache hits', () => {
    const result = getLogTokenUsage(100, 20, {
      usage_semantic: 'anthropic',
      cache_tokens: 100,
      cache_creation_tokens: 60,
      cache_creation_tokens_5m: 30,
      cache_creation_tokens_1h: 20,
    })
    expect(result.cacheWrite).toBe(60)
    expect(result.totalInput).toBe(260)
    expect(result.hitRate).toBeCloseTo((100 / 260) * 100)
  })
  test('missing cache data differs from an explicit zero', () => {
    expect(getLogTokenUsage(100, 20, {}).hitRate).toBeNull()
    expect(getLogTokenUsage(100, 20, { cache_tokens: 0 }).hitRate).toBe(0)
    expect(getLogTokenUsage(0, 0, { cache_tokens: 0 }).hitRate).toBeNull()
    expect(getLogTokenUsage(100, 20, { cache_tokens: 200 }).hitRate).toBeNull()
  })
})
