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

import { getDegradationWatchHistory, getDegradationWatchWall } from '../api'
import { RecordCard } from '../components/record-card'
import { WatchWall } from '../components/watch-wall'
import type { DegradationWatchRecord } from '../types'

vi.mock('../hooks/use-degradation-watch', async (original) => ({
  ...(await original<typeof import('../hooks/use-degradation-watch')>()),
  useInViewport: () => ({ ref: { current: null }, inView: true }),
  useRecordHtml: () => ({}),
}))
vi.mock('../api', () => ({
  getDegradationWatchHistory: vi.fn(),
  getDegradationWatchWall: vi.fn(),
}))
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

test('each model starts with four cards and loads older checks only on request', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  vi.mocked(getDegradationWatchWall).mockResolvedValue({
    success: true,
    data: {
      enabled: true,
      interval_minutes: 10,
      rounds: [],
      next_before: 0,
      lanes: ['sol', 'astra'].map((model) => ({
        model,
        configured: true,
        enabled: true,
        reasoning_effort: 'high',
        total: 8,
        succeeded: 0,
        visible: 8,
        avg_elapsed_ms: 0,
        last_record_at: 1000,
      })),
    },
  })
  let newestID = 8
  vi.mocked(getDegradationWatchHistory).mockImplementation(
    async (model, before) => {
      const top = before ? before - 1 : newestID
      return {
        success: true,
        data: {
          records: Array.from({ length: 4 }, (_, i) => ({
            ...record,
            id: top - i,
            model_name: model,
            channel_title: `${model}-${top - i}`,
          })),
          next_before: top > 4 ? top - 3 : 0,
        },
      }
    }
  )
  const view = render(
    <QueryClientProvider client={client}>
      <WatchWall />
    </QueryClientProvider>
  )
  const lane = within(await screen.findByRole('region', { name: 'sol' }))
  await waitFor(() => expect(lane.getAllByRole('article')).toHaveLength(4))
  expect(lane.queryByText('sol-4')).toBeNull()
  fireEvent.click(lane.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(lane.getAllByRole('article')).toHaveLength(8))
  expect(lane.getByText('sol-8')).toBeInTheDocument()
  expect(lane.getByText('sol-1')).toBeInTheDocument()
  expect(lane.queryByRole('button', { name: 'Load more' })).toBeNull()
  expect(
    within(screen.getByRole('region', { name: 'astra' })).getAllByRole(
      'article'
    )
  ).toHaveLength(4)
  newestID = 10
  await act(async () => {
    await client.refetchQueries({ queryKey: ['degradation-watch', 'wall'] })
  })
  expect(lane.getAllByRole('article')).toHaveLength(8)
  expect(lane.queryByText('sol-10')).toBeNull()
  fireEvent.click(lane.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(lane.getAllByRole('article')).toHaveLength(4))
  expect(await lane.findByText('sol-10')).toBeInTheDocument()
  view.unmount()
  client.clear()
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

test('cached expired cards disappear when the server retention window advances, while running checks remain', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wall = {
    enabled: true,
    interval_minutes: 10,
    rounds: [],
    next_before: 0,
    retention_since: 0,
    lanes: [
      {
        model: 'sol',
        configured: true,
        enabled: true,
        reasoning_effort: 'high',
        total: 1,
        succeeded: 0,
        visible: 1,
        avg_elapsed_ms: 0,
        last_record_at: 1000,
      },
    ],
  }
  vi.mocked(getDegradationWatchWall).mockResolvedValue({
    success: true,
    data: wall,
  })
  vi.mocked(getDegradationWatchHistory).mockResolvedValue({
    success: true,
    data: {
      records: [
        { ...record, id: 1, channel_title: 'expired check', status: 'failed' },
        { ...record, id: 2, channel_title: 'running check', status: 'running' },
      ],
      next_before: 0,
    },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <WatchWall />
    </QueryClientProvider>
  )
  expect(await screen.findByText('expired check')).toBeInTheDocument()
  await act(async () => {
    client.setQueryData(['degradation-watch', 'wall'], {
      ...wall,
      retention_since: 1001,
    })
  })
  await waitFor(() => expect(screen.queryByText('expired check')).toBeNull())
  expect(screen.getByText('running check')).toBeInTheDocument()
  view.unmount()
  client.clear()
})
