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
import { zodResolver } from '@hookform/resolvers/zod'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'

import { SafeNumberInput } from '../numeric-field'

// `.min(0)` 是全部调用点里最危险的一档：空字符串会被 coerce 成 0 并通过校验，
// 于是「清空输入框」会静默存成 0。下面用它盯住这件事。
const schema = z.object({ amount: z.coerce.number().min(0).max(100) })

function Fixture({
  onSubmit = () => {},
}: {
  onSubmit?: (values: { amount: number }) => void
}) {
  const form = useForm({
    defaultValues: { amount: 12 },
    resolver: zodResolver(schema),
  })
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name='amount'
          render={({ field, fieldState }) => (
            <FormItem>
              <FormLabel>Amount</FormLabel>
              <FormControl>
                {/*
                  step 与下面这些小数用例保持一致：浏览器会按 step 做原生校验，
                  步长不匹配时点击保存会连 submit 事件都不发，请求根本不会出去。
                */}
                <SafeNumberInput
                  field={field}
                  min={0}
                  max={100}
                  step={0.01}
                  aria-invalid={fieldState.invalid}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <button type='submit'>Save</button>
      </form>
    </Form>
  )
}

function setup() {
  const submit = vi.fn()
  render(<Fixture onSubmit={submit} />)
  return {
    submit,
    input: screen.getByRole('spinbutton', { name: 'Amount' }),
    save: screen.getByRole('button', { name: 'Save' }),
  }
}

it('lets the user clear the field and type a fresh decimal', async () => {
  const user = userEvent.setup()
  const { submit, input, save } = setup()

  // 修复前：清空时 valueAsNumber 是 NaN，onChange 被丢掉，React 再把 props.value
  // 写回 DOM，于是清空动作会被立刻撤销，输入框根本清不掉。
  await user.clear(input)
  expect(input).toHaveValue(null)

  await user.type(input, '1.5')
  expect(input).toHaveValue(1.5)

  await user.click(save)
  // 表单状态里始终是数字：不是 '1.5'，也不是 ''。
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      { amount: 1.5 },
      expect.anything() as unknown
    )
  )
})

it('keeps the last valid number when the field is cleared and saved', async () => {
  const user = userEvent.setup()
  const { submit, input, save } = setup()

  await user.clear(input)
  await user.click(save)

  // 清空不是「0」的意思：空字段不该被 coerce 成 0 存下去。
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      { amount: 12 },
      expect.anything() as unknown
    )
  )
})

it('shows the committed number again after leaving an emptied field', async () => {
  const user = userEvent.setup()
  const { input } = setup()

  await user.clear(input)
  expect(input).toHaveValue(null)

  await user.tab()
  expect(input).toHaveValue(12)
})

it('refuses to submit a value outside the range the input declares', async () => {
  const user = userEvent.setup()
  const { submit, input, save } = setup()

  await user.clear(input)
  await user.type(input, '101')
  expect(input).toHaveValue(101)
  // 出界值是原生约束拦下的：浏览器在 submit 之前就中止，事件根本不会发出，
  // 所以既不会保存，也不会走到 schema 那一步（真实浏览器此时会弹出提示气泡）。
  expect((input as HTMLInputElement).validity.rangeOverflow).toBe(true)

  await user.click(save)
  expect(submit).not.toHaveBeenCalled()
})
