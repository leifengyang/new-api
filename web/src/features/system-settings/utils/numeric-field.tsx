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
import { useState, type ComponentProps } from 'react'
import type {
  ControllerRenderProps,
  FieldPath,
  FieldValues,
} from 'react-hook-form'
import { z } from 'zod'

import { Input } from '@/components/ui/input'

// 正整数的 zod 校验器，和它校验的输入框放在同一个模块里；本文件因此同时导出
// 组件和非组件，热更新规则在这里没有意义。
// eslint-disable-next-line react/only-export-components
export function positiveIntegerSchema(message: string) {
  return z.number().int(message).positive(message)
}

/**
 * Props for {@link SafeNumberInput}: everything our shared `Input` accepts
 * except the controlled-input props, which the adapter owns, plus the
 * react-hook-form `field`. `type` is pinned to `number` so callers cannot
 * accidentally bind a text input to a numeric field.
 */
export type SafeNumberInputProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> = Omit<
  ComponentProps<typeof Input>,
  'value' | 'defaultValue' | 'onChange' | 'name' | 'ref' | 'type'
> & {
  field: ControllerRenderProps<TFieldValues, TName>
}

/**
 * Binds a react-hook-form numeric field to a native `<input type="number">`
 * so the field stays freely editable without ever putting a non-number into
 * form state.
 *
 * Why this exists:
 * - `<input type="number">` reports `valueAsNumber === NaN` when the field is
 *   empty. Forwarding `NaN` to `field.onChange` makes Zod numeric validators
 *   (`z.number().min(...)`, `z.coerce.number()`, etc.) fail at submit time, so
 *   `form.handleSubmit` silently refuses to call `onSubmit` — the save button
 *   appears frozen with no toast and no error.
 * - A numeric field has no value that means "empty", so the in-progress text
 *   cannot live in form state: React writes the controlled value back to the
 *   DOM after every event, which used to make it impossible to clear the
 *   field at all (the old adapter dropped `NaN` and React restored the
 *   previous number). That is why the draft is kept here, in local state,
 *   and form state only ever receives finite numbers.
 *
 * Behaviour:
 * - While typing, the input shows exactly what was typed (including an empty
 *   field), and only a finite number is written back to the form.
 * - On blur the draft is dropped. Left empty, the input shows the number the
 *   form actually holds rather than quietly saving `0`.
 *
 * Usage:
 * ```tsx
 * <FormField
 *   control={form.control}
 *   name='performance_setting.monitor_cpu_threshold'
 *   render={({ field, fieldState }) => (
 *     <SafeNumberInput field={field} min={0} aria-invalid={fieldState.invalid} />
 *   )}
 * />
 * ```
 */
export function SafeNumberInput<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({ field, onBlur, ...inputProps }: SafeNumberInputProps<TFieldValues, TName>) {
  const raw = field.value as unknown
  const committed =
    typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <Input
      {...inputProps}
      ref={field.ref}
      name={field.name}
      type='number'
      value={draft ?? committed}
      onChange={(event) => {
        setDraft(event.target.value)
        const next = event.target.valueAsNumber
        if (Number.isFinite(next)) {
          ;(field.onChange as (value: number) => void)(next)
        }
      }}
      onBlur={(event) => {
        setDraft(null)
        field.onBlur()
        onBlur?.(event)
      }}
    />
  )
}
