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
let drawings: DegradationWatchRecord[] = []
let failOlderDrawings = false
beforeEach(() => {
  since = 0
  drawings = []
  failOlderDrawings = false
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
      if (
        config.params.probe_id === 'drawing' &&
        config.params.before &&
        failOlderDrawings
      ) {
        throw new Error('offline')
      }
      return {
        data: {
          success: true,
          data: {
            since,
            probes: [
              ...(drawings.length
                ? [
                    {
                      id: 'drawing',
                      name: 'Drawing',
                      kind: 'drawing',
                      enabled: true,
                      interval_minutes: 60,
                      stats: {
                        passed: 7,
                        mismatched: 0,
                        errors: 0,
                        avg_elapsed_ms: 1200,
                      },
                      records:
                        config.params.before &&
                        config.params.probe_id === 'drawing'
                          ? [{ ...drawings[0], id: 90 }]
                          : drawings,
                      next_before: config.params.before ? 0 : 95,
                    },
                  ]
                : []),
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
    if (String(url).endsWith('/html')) {
      return { data: { success: true, data: { html: '<html><svg/></html>' } } }
    }
    if (String(url).startsWith('/api/degradation_watch/records/1')) {
      return {
        data: {
          success: true,
          data: {
            record: drawings[0],
            prompt: 'saved drawing prompt',
            output: '<html><svg>full drawing output</svg></html>',
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

test('probe blocks show answer characters without loading full replies and still open details', async () => {
  records = [
    { ...record, id: 7, answer_last_character: '苗' },
    {
      ...record,
      id: 6,
      success: false,
      status: 'failed',
      verdict: 'mismatch',
      answer_last_character: 'n',
    },
    { ...record, id: 5, answer_last_character: '𠮷' },
    { ...record, id: 4, success: false, status: 'failed', verdict: 'error' },
  ]
  const { view, client } = setup()
  const section = within(
    await screen.findByRole('region', { name: 'Text probes' })
  )
  const answer = await section.findByRole('button', { name: /· Passed · 苗/ })
  expect(answer).toHaveTextContent('苗')
  expect(
    section.getByRole('button', { name: /· Answer or drawing mismatch · n/ })
  ).toHaveTextContent('n')
  expect(
    section.getByRole('button', { name: /· Passed · 𠮷/ })
  ).toHaveTextContent('𠮷')
  expect(
    section.getByRole('button', { name: /· Request error/ })
  ).toBeEmptyDOMElement()
  expect(api.get).not.toHaveBeenCalledWith('/api/degradation_watch/records/7')
  fireEvent.click(answer)
  expect(await screen.findByText('full model response')).toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('records in the same interval stack together across history pages with a capped scrollable height', async () => {
  records = [
    { ...record, id: 12, created_at: 1300, answer_last_character: 'n' },
    ...[11, 10, 9, 8, 7].map((id) => ({
      ...record,
      id,
      answer_last_character: '苗',
    })),
  ]
  const { view, client } = setup()
  const history = within(await screen.findByLabelText('Detection history'))
  const slots = history.getAllByRole('group')
  expect(slots).toHaveLength(2)
  expect(within(slots[0]).getAllByRole('button')).toHaveLength(5)
  expect(slots[0]).toHaveClass('max-h-21', 'overflow-y-auto')
  expect(slots[0]).toHaveAttribute('tabindex', '0')
  expect(within(slots[1]).getByRole('button')).toHaveTextContent('n')
  fireEvent.click(history.getByRole('button', { name: 'Load more' }))
  await waitFor(() =>
    expect(
      within(history.getAllByRole('group')[0]).getAllByRole('button')
    ).toHaveLength(6)
  )
  expect(history.getAllByRole('group')).toHaveLength(2)
  view.unmount()
  client.clear()
})

test('admin-only probe blocks are translucent and hidden drawings have an accessible closed-eye marker', async () => {
  records = [{ ...record, public_visible: false, answer_last_character: '苗' }]
  drawings = [
    {
      ...record,
      id: 100,
      probe_kind: 'drawing',
      probe_id: 'drawing',
      public_visible: false,
    },
  ]
  const { view, client } = setup()
  const text = within(
    await screen.findByRole('region', { name: 'Text probes' })
  )
  const button = await text.findByRole('button', { name: /· Passed · 苗/ })
  expect(button).toHaveClass('opacity-50')
  expect(button).toBeEnabled()
  const drawing = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  expect(
    await drawing.findByRole('img', { name: 'Hidden' })
  ).toBeInTheDocument()
  expect(drawing.getByRole('button', { name: 'View artwork' })).toBeEnabled()
  view.unmount()
  client.clear()
})

test('wall excludes errors from pass rate, shows live tokens and fetches details only when selected', async () => {
  const { view, client } = setup()
  const lane = within(
    await within(
      await screen.findByRole('region', { name: 'Text probes' })
    ).findByRole('article', { name: 'alpha / sol' })
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
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Copy prompt',
    })
  ).toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('older history is loaded on demand, stays anchored, and can return to live records', async () => {
  const { view, client } = setup()
  const lane = within(
    await within(
      await screen.findByRole('region', { name: 'Text probes' })
    ).findByRole('article', { name: 'alpha / sol' })
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
    await within(
      await screen.findByRole('region', { name: 'Text probes' })
    ).findByRole('article', { name: 'alpha / sol' })
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

test('drawing lanes show five cards, append on demand and reset to five when returning live', async () => {
  drawings = [100, 99, 98, 97, 96, 95].map((id) => ({
    ...record,
    id,
    probe_id: 'drawing',
    probe_name: 'Drawing',
    probe_kind: 'drawing',
  }))
  const { view, client } = setup()
  const section = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  const history = within(
    await section.findByRole('region', { name: 'Drawing history' })
  )
  expect(history.getAllByRole('button', { name: 'View artwork' })).toHaveLength(
    5
  )
  expect(
    within(screen.getByRole('region', { name: 'Text probes' })).queryByRole(
      'button',
      { name: 'View artwork' }
    )
  ).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith(
    '/api/degradation_watch/records/95/html'
  )
  fireEvent.click(history.getByRole('button', { name: 'Load more' }))
  expect(
    await history.findAllByRole('button', { name: 'View artwork' })
  ).toHaveLength(6)
  fireEvent.click(history.getByRole('button', { name: 'Load more' }))
  await waitFor(() =>
    expect(
      history.getAllByRole('button', { name: 'View artwork' })
    ).toHaveLength(7)
  )
  expect(
    history.queryByRole('button', { name: 'Load more' })
  ).not.toBeInTheDocument()
  drawings = [{ ...drawings[0], id: 101 }, ...drawings]
  await act(async () => {
    await client.refetchQueries({ queryKey: ['degradation-watch', 'monitor'] })
  })
  expect(history.getAllByRole('button', { name: 'View artwork' })).toHaveLength(
    7
  )
  fireEvent.click(section.getByRole('button', { name: 'Return to live' }))
  expect(history.getAllByRole('button', { name: 'View artwork' })).toHaveLength(
    5
  )
  view.unmount()
  client.clear()
})

test('drawing input opens its saved prompt and the large dialog exposes full output', async () => {
  drawings = [
    {
      ...record,
      id: 100,
      probe_kind: 'drawing',
      probe_id: 'drawing',
      probe_name: 'Drawing',
    },
  ]
  const { view, client } = setup()
  const section = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  fireEvent.click(await section.findByRole('button', { name: 'View artwork' }))
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Drawing check details' })
  )
  const input = dialog.getByRole('button', { name: 'View input details' })
  expect(input).toHaveAttribute('aria-expanded', 'false')
  expect(dialog.queryByText('saved drawing prompt')).not.toBeInTheDocument()
  fireEvent.click(input)
  expect(await dialog.findByText('saved drawing prompt')).toBeInTheDocument()
  expect(input).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(dialog.getByRole('tab', { name: 'Full output' }))
  expect(
    await dialog.findByText('<html><svg>full drawing output</svg></html>')
  ).toBeInTheDocument()
  expect(
    dialog.getAllByRole('button', { name: 'Copy full output' }).length
  ).toBeGreaterThan(0)
  view.unmount()
  client.clear()
})

test('failed older drawing loads keep existing cards and allow retry', async () => {
  drawings = [
    {
      ...record,
      id: 100,
      probe_kind: 'drawing',
      probe_id: 'drawing',
      probe_name: 'Drawing',
    },
  ]
  failOlderDrawings = true
  const { view, client } = setup()
  const section = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  fireEvent.click(await section.findByRole('button', { name: 'Load more' }))
  const retry = await section.findByRole('button', { name: 'Retry' })
  expect(section.getAllByRole('button', { name: 'View artwork' })).toHaveLength(
    1
  )
  failOlderDrawings = false
  fireEvent.click(retry)
  await waitFor(() =>
    expect(
      section.getAllByRole('button', { name: 'View artwork' })
    ).toHaveLength(2)
  )
  view.unmount()
  client.clear()
})
