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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { TemporaryMonitorPanel } from '../components/temporary-monitor-panel'
import type { MonitorAttempt, TemporaryMonitor } from '../lib/temporary-monitor'

const monitor: TemporaryMonitor = {
  id: 1,
  name: 'Trial upstream',
  base_url: 'https://example.com/v1',
  model: 'trial-model',
  protocol: 'chat',
  status: 'running',
  created_at: 1000,
  ends_at: 87400,
  drawing_prompt: 'Draw a complete SVG in HTML',
}
const attempt: MonitorAttempt = {
  id: 7,
  kind: 'text',
  verdict: 'passed',
  round_id: 0,
  group_index: 0,
  attempt: 1,
  profile_id: 0,
  name: monitor.name,
  base_url: monitor.base_url,
  model: monitor.model,
  protocol: 'chat',
  effort: 'low',
  status: 'succeeded',
  output: '',
  html: '',
  error: '',
  input_tokens: 15,
  output_tokens: 5,
  reasoning_tokens: 0,
  tokens_estimated: false,
  elapsed_ms: 1500,
  first_token_ms: 300,
  created_at: 1000,
  started_at: 1000000,
}
let monitors: TemporaryMonitor[]
let failCreate: boolean
beforeEach(() => {
  monitors = [{ ...monitor }]
  failCreate = false
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    const url = String(config.url)
    const response = (data: unknown) => ({ data: { success: true, data } })
    if (url.endsWith('/temporary-monitors') && config.method === 'post') {
      if (failCreate) throw new Error('upstream invalid')
      monitors = [{ ...monitor, name: 'New trial' }]
      return response(monitors[0])
    }
    if (url.includes('/temporary-monitors?')) {
      return response({ monitors, next_before: 0 })
    }
    if (url.endsWith('/1/stop')) {
      monitors = [{ ...monitor, status: 'stopped' }]
      return response(null)
    }
    if (url.includes('/temporary-monitors/attempts/')) {
      return response({
        ...attempt,
        output: 'Full saved upstream answer',
        html: url.endsWith('/7') ? '' : '<html><svg/></html>',
      })
    }
    if (url.includes('/temporary-monitors/1?')) {
      const drawing = url.includes('kind=drawing')
      const older = url.includes('before=20')
      let attempts = [attempt]
      if (drawing) {
        const ids = older ? [19] : [25, 24, 23, 22, 21]
        attempts = ids.map((id) => ({ ...attempt, id, kind: 'drawing' }))
      }
      return response({
        monitor: monitors[0],
        attempts,
        stats: [
          { verdict: 'passed', status: 'succeeded', count: drawing ? 6 : 1 },
        ],
        next_before: drawing && !older ? 20 : 0,
        text_prompt: 'Saved Sanae prompt',
        expected: 'Expected answer',
      })
    }
    throw new Error(`Unexpected request ${url}`)
  })
})
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <TemporaryMonitorPanel />
    </QueryClientProvider>
  )
  return { client, view }
}

test('temporary monitor starts with separate reasoning levels and no remembered self-test profile', async () => {
  monitors = []
  const { view, client } = setup()
  await screen.findByText('No checks to display')
  fireEvent.click(
    screen.getByRole('button', { name: 'Start temporary monitoring' })
  )
  const dialog = within(
    screen.getByRole('dialog', { name: 'Start temporary monitoring' })
  )
  fireEvent.change(dialog.getByLabelText('Group name'), {
    target: { value: 'New trial' },
  })
  fireEvent.change(dialog.getByLabelText('Base URL'), {
    target: { value: 'https://example.com/v1' },
  })
  fireEvent.change(dialog.getByLabelText('API key'), {
    target: { value: 'test-key' },
  })
  fireEvent.change(dialog.getByLabelText('Model'), {
    target: { value: 'trial-model' },
  })
  await userEvent.selectOptions(
    dialog.getByLabelText('Drawing reasoning effort'),
    'high'
  )
  await userEvent.selectOptions(
    dialog.getByLabelText('Probe reasoning effort'),
    'low'
  )
  expect(
    dialog.queryByText('Save key encrypted for reuse')
  ).not.toBeInTheDocument()
  fireEvent.click(
    dialog.getByRole('button', { name: 'Start temporary monitoring' })
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(api.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: '/api/degradation_watch/temporary-monitors',
      method: 'post',
      data: expect.objectContaining({
        text_effort: 'low',
        drawing_effort: 'high',
        remember_key: false,
        api_key: 'test-key',
        max_output_tokens: 32768,
      }),
    })
  )
  view.unmount()
  client.clear()
})

test('temporary history uses plain blocks and private details, loads older drawings and stops monitoring', async () => {
  const { view, client } = setup()
  const text = within(
    await screen.findByRole('region', { name: 'Text probes' })
  )
  const block = await text.findByRole('button', { name: /· Passed/ })
  expect(block).toBeEmptyDOMElement()
  const drawing = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  expect(
    await drawing.findAllByRole('button', { name: 'View artwork' })
  ).toHaveLength(5)
  fireEvent.click(drawing.getByRole('button', { name: 'Load more' }))
  await waitFor(() =>
    expect(
      drawing.getAllByRole('button', { name: 'View artwork' })
    ).toHaveLength(6)
  )
  fireEvent.click(block)
  const detail = within(
    await screen.findByRole('dialog', { name: 'Probe details' })
  )
  expect(
    detail.queryByRole('button', { name: 'Retry' })
  ).not.toBeInTheDocument()
  fireEvent.click(detail.getByRole('button', { name: 'Live output' }))
  expect(
    (await detail.findAllByText('Full saved upstream answer')).length
  ).toBeGreaterThan(0)
  expect(api.request).not.toHaveBeenCalledWith(
    expect.objectContaining({
      url: expect.stringContaining('/self-test/attempts/'),
    })
  )
  fireEvent.click(detail.getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await screen.findByText('Stopped')
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('invalid or failed creation keeps the temporary form available', async () => {
  monitors = []
  failCreate = true
  const { view, client } = setup()
  fireEvent.click(
    screen.getByRole('button', { name: 'Start temporary monitoring' })
  )
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(
    dialog.getByRole('button', { name: 'Start temporary monitoring' })
  )
  expect(await dialog.findByRole('alert')).toBeInTheDocument()
  expect(api.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: 'post' })
  )
  for (const [label, value] of [
    ['Group name', 'New trial'],
    ['Base URL', 'https://example.com/v1'],
    ['API key', 'test-key'],
    ['Model', 'trial-model'],
  ]) {
    fireEvent.change(dialog.getByLabelText(label), { target: { value } })
  }
  fireEvent.click(
    dialog.getByRole('button', { name: 'Start temporary monitoring' })
  )
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post' })
    )
  )
  await waitFor(() =>
    expect(
      dialog.getByRole('button', { name: 'Start temporary monitoring' })
    ).toBeEnabled()
  )
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  view.unmount()
  client.clear()
})
