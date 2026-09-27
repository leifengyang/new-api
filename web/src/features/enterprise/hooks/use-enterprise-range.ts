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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { defaultUsageRange, toUsageSeconds } from '../lib/usage'
import type { EnterpriseUsageRange } from '../types'

interface EnterpriseRange {
  /** 已校验过的秒数区间，直接拿去请求。 */
  seconds: EnterpriseUsageRange
  /** 回喂给时间选择器的 `Date`，由 `seconds` 反推。 */
  pickerRange: { start: Date; end: Date }
  handleRangeChange: (next: { start?: Date; end?: Date }) => void
}

/**
 * 用量页和成员日志页共用的时间窗状态。
 *
 * 状态里存的是校验过的秒数，选择器要的 `Date` 由它反推 —— 这样「用户选了个不合法的
 * 区间」不会落进状态，也就不存在「表里是新区间、数字是旧区间」的错位。
 */
export function useEnterpriseRange(): EnterpriseRange {
  const { t } = useTranslation()
  const [seconds, setSeconds] = useState<EnterpriseUsageRange>(() => {
    const initial = defaultUsageRange()
    return {
      start: Math.floor(initial.start.getTime() / 1000),
      end: Math.floor(initial.end.getTime() / 1000),
    }
  })

  const pickerRange = useMemo(
    () => ({
      start: new Date(seconds.start * 1000),
      end: new Date(seconds.end * 1000),
    }),
    [seconds]
  )

  const handleRangeChange = (next: { start?: Date; end?: Date }) => {
    const result = toUsageSeconds(next)
    if (result.ok) {
      setSeconds(result.range)
      return
    }
    // 只填了一头是「还没选完」，不用打扰用户；两头都有却反了才要说一句。
    if (result.reason === 'invalid') {
      toast.error(
        t(
          'The start time must be earlier than the end time, and the range cannot exceed one year.'
        )
      )
    }
  }

  return { seconds, pickerRange, handleRangeChange }
}
