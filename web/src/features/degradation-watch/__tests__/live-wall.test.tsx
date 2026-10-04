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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { getDegradationWatchHistory } from '../api'
import { RecordCard } from '../components/record-card'
import { WatchWall } from '../components/watch-wall'
import {
  useDegradationWatchHistory,
  useDegradationWatchWall,
} from '../hooks/use-degradation-watch'
import type { DegradationWatchRecord } from '../types'

vi.mock('../hooks/use-degradation-watch', () => ({
  useInViewport: () => ({ ref: { current: null }, inView: true }),
  useRecordHtml: () => ({}),
  useDegradationWatchHistory: vi.fn(),
  useDegradationWatchWall: vi.fn(),
}))
vi.mock('../api', () => ({ getDegradationWatchHistory: vi.fn() }))
afterEach(() => vi.useRealTimers())

vi.mock('../components/artwork-player-dialog', () => ({
  RecordPlayerDialog: () => null,
}))

const record: DegradationWatchRecord = {
  id: 1,
  model_name: 'sol',
  reasoning_effort: 'high',
  channel_title: 'Demo',
  aliased: true,
  success: false,
  failure_reason: '',
  elapsed_ms: 2000,
  prompt_tokens: 20,
  completion_tokens: 12,
  reasoning_tokens: 0,
  hidden: false,
  created_at: 1000,
}

test('a running record displays live usage instead of a failure', () => {
  render(
    <RecordCard
      record={{ ...record, status: 'running', tokens_estimated: true }}
      onOpen={vi.fn()}
    />
  )
  expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  expect(screen.getByText('Running')).toBeInTheDocument()
  expect(screen.getByText('Input tokens')).toBeInTheDocument()
  expect(screen.getByText('20')).toBeInTheDocument()
  expect(screen.getByText('12')).toBeInTheDocument()
  expect(screen.getByText('Estimated')).toBeInTheDocument()
})

test('failed cards retain the complete diagnostic with line breaks', () => {
  const details = `HTTP 429\n${'Upstream detail '.repeat(100)}\nrequest-id: final-line`
  render(
    <RecordCard
      record={{
        ...record,
        status: 'failed',
        failure_reason: 'upstream_error',
        error_details: details,
      }}
      onOpen={vi.fn()}
    />
  )
  expect(screen.getByText(/request-id: final-line/).textContent).toBe(details)
})

test('each model displays its own recent history without empty round placeholders', () => {
  vi.mocked(useDegradationWatchWall).mockReturnValue({
    data: {
      lanes: ['sol', 'astra'].map((model) => ({
        model,
        configured: true,
        enabled: true,
        total: 1,
        succeeded: 0,
      })),
    },
  } as ReturnType<typeof useDegradationWatchWall>)
  vi.mocked(useDegradationWatchHistory).mockImplementation(
    (model) =>
      ({
        data: {
          records: [
            {
              ...record,
              id: model === 'sol' ? 20 : 1,
              model_name: model,
              channel_title: `${model} channel`,
              created_at: model === 'sol' ? 2000 : 1000,
            },
          ],
          next_before: 0,
        },
      }) as ReturnType<typeof useDegradationWatchHistory>
  )
  render(<WatchWall />)
  expect(
    within(screen.getByRole('region', { name: 'sol' })).getByText('sol channel')
  ).toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: 'astra' })).getByText(
      'astra channel'
    )
  ).toBeInTheDocument()
  expect(screen.queryAllByText('—')).toHaveLength(0)
})

test('paging a lane replaces its cards and lets the user return to recent records', () => {
  vi.mocked(useDegradationWatchWall).mockReturnValue({
    data: { lanes: [{ model: 'sol', total: 30, succeeded: 30 }] },
  } as ReturnType<typeof useDegradationWatchWall>)
  vi.mocked(useDegradationWatchHistory).mockImplementation(
    (_model, before) =>
      ({
        data: {
          records: Array.from({ length: 10 }, (_, i) => ({
            ...record,
            id: (before || 30) - i,
            channel_title: `check-${(before || 30) - i}`,
          })),
          next_before: before ? 0 : 20,
        },
      }) as ReturnType<typeof useDegradationWatchHistory>
  )
  render(<WatchWall />)
  expect(screen.getAllByRole('article')).toHaveLength(10)
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.queryByText('check-30')).toBeNull()
  expect(screen.getByText('check-20')).toBeInTheDocument()
  expect(screen.getAllByRole('article')).toHaveLength(10)
  fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
  expect(screen.getByText('check-30')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
})

test('history polls the current page without polling old completed pages or invisible lanes', async () => {
  const actual = await vi.importActual<
    typeof import('../hooks/use-degradation-watch')
  >('../hooks/use-degradation-watch')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  vi.mocked(getDegradationWatchHistory).mockImplementation(
    async (_model, before) => ({
      success: true,
      data: {
        records: [
          { ...record, status: before === 0 ? 'running' : 'succeeded' },
        ],
        next_before: 1,
      },
    })
  )
  const view = renderHook(
    ({ before, enabled }) => {
      const history = actual.useDegradationWatchHistory('sol', before, enabled)
      return { data: history.data, isSuccess: history.isSuccess }
    },
    { wrapper, initialProps: { before: 0, enabled: false } }
  )
  expect(getDegradationWatchHistory).not.toHaveBeenCalled()
  view.rerender({ before: 0, enabled: true })
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  view.rerender({ before: 0, enabled: false })
  view.rerender({ before: 0, enabled: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await waitFor(() =>
    expect(
      vi
        .mocked(getDegradationWatchHistory)
        .mock.calls.filter(([, before]) => before === 0).length
    ).toBeGreaterThan(1)
  )
  vi.useRealTimers()
  await act(async () => {
    view.rerender({ before: 20, enabled: true })
  })
  await waitFor(() =>
    expect(view.result.current.data?.records[0].status).toBe('succeeded')
  )
  view.rerender({ before: 20, enabled: false })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  view.rerender({ before: 20, enabled: true })
  const calls = vi.mocked(getDegradationWatchHistory).mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(getDegradationWatchHistory).toHaveBeenCalledTimes(calls)
  view.unmount()
  client.clear()
})
