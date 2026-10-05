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
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { ProbeWall } from '../components/probe-wall'
import type { DegradationWatchRecord } from '../types'

const record: DegradationWatchRecord = {
  id: 5,
  model_name: 'sol',
  group_name: 'alpha',
  probe_id: 'sanae',
  probe_name: 'Sanae',
  probe_kind: 'text',
  reasoning_effort: '',
  channel_title: '',
  aliased: false,
  success: true,
  verdict: 'passed',
  failure_reason: '',
  elapsed_ms: 1000,
  prompt_tokens: 15,
  completion_tokens: 5,
  reasoning_tokens: 0,
  hidden: false,
  created_at: 1000,
  status: 'succeeded',
}
let records: DegradationWatchRecord[]
let since = 0
beforeEach(() => {
  since = 0
  records = [
    { ...record, id: 7, success: false, status: 'running' },
    {
      ...record,
      id: 6,
      success: false,
      status: 'failed',
      verdict: 'error',
      failure_reason: 'timeout',
    },
    record,
  ]
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/api/degradation_watch/monitor') {
      if (!config?.params?.model) {
        return {
          data: {
            success: true,
            data: { lanes: [{ group: 'alpha', model: 'sol', enabled: true }] },
          },
        }
      }
      return {
        data: {
          success: true,
          data: {
            since,
            probes: [
              {
                id: 'sanae',
                name: 'Sanae',
                kind: 'text',
                enabled: true,
                interval_minutes: 5,
                stats: {
                  passed: 1,
                  mismatched: 1,
                  errors: 1,
                  avg_elapsed_ms: 1000,
                },
                records: config.params.before
                  ? [{ ...record, id: 4 }]
                  : records,
                next_before: config.params.before ? 0 : 5,
              },
            ],
          },
        },
      }
    }
    if (url === '/api/degradation_watch/records/7') {
      return {
        data: {
          success: true,
          data: {
            record: records[0],
            prompt: 'historic prompt',
            expected: 'expected answer',
            match: 'exact',
            output: 'full model response',
          },
        },
      }
    }
    throw new Error(`Unexpected ${url}`)
  })
})

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <ProbeWall />
    </QueryClientProvider>
  )
  return { client, view }
}

test('wall excludes errors from pass rate, shows live tokens and fetches details only when selected', async () => {
  const { view, client } = setup()
  const lane = within(
    await screen.findByRole('article', { name: 'alpha / sol' })
  )
  expect(await lane.findByText('50%')).toBeInTheDocument()
  expect(lane.getByText('Input tokens: 15')).toBeInTheDocument()
  expect(lane.getByText('Output tokens: 5')).toBeInTheDocument()
  expect(screen.queryByText(/channel/i)).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/api/degradation_watch/records/7')
  fireEvent.click(lane.getByRole('button', { name: /· Running/ }))
  expect(await screen.findByText('historic prompt')).toBeInTheDocument()
  expect(screen.getByText('expected answer')).toBeInTheDocument()
  expect(screen.getByText('full model response')).toBeInTheDocument()
  expect(
    within(screen.getByRole('dialog')).getAllByRole('button', {
      name: 'Copy to clipboard',
    })
  ).toHaveLength(2)
  view.unmount()
  client.clear()
})

test('older history is loaded on demand, stays anchored, and can return to live records', async () => {
  const { view, client } = setup()
  const lane = within(
    await screen.findByRole('article', { name: 'alpha / sol' })
  )
  fireEvent.click(await lane.findByRole('button', { name: 'Load more' }))
  expect(
    await lane.findByRole('button', { name: 'Return to live' })
  ).toBeInTheDocument()
  const history = within(lane.getByLabelText('Detection history'))
  await screen.findByText('50%')
  await act(async () => {
    await client.refetchQueries({ queryKey: ['degradation-watch', 'monitor'] })
  })
  expect(history.getAllByRole('button')).toHaveLength(4)
  records = [{ ...record, id: 8, created_at: 1200 }]
  await act(async () => {
    await client.refetchQueries({ queryKey: ['degradation-watch', 'monitor'] })
  })
  expect(history.getAllByRole('button')).toHaveLength(4)
  fireEvent.click(lane.getByRole('button', { name: 'Return to live' }))
  await waitFor(() => expect(history.getAllByRole('button')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }))
  expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  view.unmount()
  client.clear()
})

test('expired cached history disappears while active attempts remain visible', async () => {
  const { view, client } = setup()
  const lane = within(
    await screen.findByRole('article', { name: 'alpha / sol' })
  )
  fireEvent.click(await lane.findByRole('button', { name: 'Load more' }))
  const history = within(lane.getByLabelText('Detection history'))
  await waitFor(() => expect(history.getAllByRole('button')).toHaveLength(4))
  since = 1001
  await act(async () => {
    await client.refetchQueries({ queryKey: ['degradation-watch', 'monitor'] })
  })
  await waitFor(() => expect(history.getAllByRole('button')).toHaveLength(1))
  expect(history.getByRole('button', { name: /· Running/ })).toBeInTheDocument()
  view.unmount()
  client.clear()
})
