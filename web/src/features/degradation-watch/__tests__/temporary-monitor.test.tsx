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
import { newTestGroup, type TestGroup } from '../lib/comparison'
import type { MonitorAttempt, TemporaryMonitor } from '../lib/temporary-monitor'

const monitor: TemporaryMonitor = {
  id: 1,
  name: 'Trial upstream',
  base_url: 'https://example.com/v1',
  model: 'trial-model',
  protocol: 'chat',
  status: 'running',
  created_at: 1000,
  ends_at: Math.floor(Date.now() / 1000) + 86400,
  drawing_prompt: 'Draw a complete SVG in HTML',
  text_prompt: 'Current text question',
  text_expected: 'Current answer',
  text_disabled: false,
  drawing_disabled: false,
  text_interval_minutes: 3,
  drawing_interval_minutes: 10,
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
let failProbeSave: boolean
let queuedKinds: Set<string>
let rewriter: TestGroup
beforeEach(() => {
  rewriter = {
    ...newTestGroup(),
    name: 'Dedicated rewrite model',
    base_url: 'https://rewrite.example.com/v1',
    model: 'rewrite-model',
    api_key: '',
    has_saved_key: true,
  }
  monitors = [{ ...monitor }]
  failCreate = false
  failProbeSave = false
  queuedKinds = new Set()
  vi.spyOn(api, 'request').mockImplementation(async (config) => {
    const url = String(config.url)
    const response = (data: unknown) => ({ data: { success: true, data } })
    if (url.endsWith('/rewriter/models')) {
      return response(['rewrite-model', 'replacement-model'])
    }
    if (url.endsWith('/rewriter')) {
      if (config.method === 'post') {
        if (failProbeSave) throw new Error('could not save rewriter')
        rewriter = {
          ...(config.data as TestGroup),
          api_key: '',
          has_saved_key: true,
        }
      }
      return response(rewriter)
    }
    if (url.endsWith('/temporary-monitors') && config.method === 'post') {
      if (failCreate) throw new Error('upstream invalid')
      monitors = [{ ...monitor, name: 'New trial' }]
      return response(monitors[0])
    }
    if (url.endsWith('/1/configuration')) {
      return response({
        ...monitors[0],
        has_saved_key: monitors[0].status === 'running',
        text_effort: 'low',
        drawing_effort: 'high',
      })
    }
    if (url.endsWith('/1/models')) {
      return response(['trial-model', 'replacement-model'])
    }
    if (url.endsWith('/temporary-monitors/1') && config.method === 'delete') {
      if (failProbeSave) throw new Error('could not delete')
      monitors = monitors.filter((monitor) => monitor.id !== 1)
      return response(null)
    }
    if (url.endsWith('/temporary-monitors/1') && config.method === 'put') {
      if (failProbeSave) throw new Error('could not update')
      const input = config.data as TemporaryMonitor & { restart: boolean }
      monitors = [
        {
          ...monitors[0],
          ...input,
          id: monitors[0].id,
          status: input.restart ? 'running' : monitors[0].status,
        },
      ]
      return response(monitors[0])
    }
    if (url.includes('/temporary-monitors?')) {
      return response({ monitors, next_before: 0 })
    }
    if (url.endsWith('/1/stop')) {
      monitors = [{ ...monitor, status: 'stopped' }]
      return response(null)
    }
    if (url.includes('/1/probes/')) {
      const kind = url.includes('/probes/text') ? 'text' : 'drawing'
      if (url.endsWith('/prompt')) {
        if (failProbeSave) throw new Error('could not save prompt')
        const input = config.data as { prompt: string; expected: string }
        monitors = [
          {
            ...monitors[0],
            [`${kind}_prompt`]: input.prompt,
            ...(kind === 'text' ? { text_expected: input.expected } : {}),
          },
        ]
      } else if (url.endsWith('/run')) {
        queuedKinds.add(kind)
      } else {
        if (failProbeSave) throw new Error('could not save schedule')
        const input = config.data as {
          enabled: boolean
          interval_minutes: number
        }
        monitors = [
          {
            ...monitors[0],
            [`${kind}_disabled`]: !input.enabled,
            [`${kind}_interval_minutes`]: input.interval_minutes,
          },
        ]
      }
      return response(null)
    }
    if (url.includes('/temporary-monitors/attempts/')) {
      return response({
        ...attempt,
        output: 'Full saved upstream answer',
        prompt: 'Historical actual input',
        original_prompt: 'Original drawing template',
        rewrite_prompt: 'Replace the subject with a turtle',
        preparation: {
          ...attempt,
          input_tokens: 123,
          output: 'Draw a turtle in SVG',
        },
        html: url.endsWith('/7') ? '' : '<html><svg/></html>',
      })
    }
    if (url.includes('/temporary-monitors/1?')) {
      const drawing = url.includes('kind=drawing')
      const older = url.includes('before=20')
      let attempts = [attempt]
      if (drawing) {
        const ids = older ? [19] : [25, 24, 23, 22, 21]
        attempts = ids.map((id) => ({
          ...attempt,
          id,
          kind: 'drawing',
          subject: '乌龟',
          phase: 'detecting',
        }))
      }
      return response({
        monitor: monitors[0],
        attempts,
        stats: [
          { verdict: 'passed', status: 'succeeded', count: drawing ? 6 : 1 },
          {
            verdict: '',
            status: 'queued',
            count: queuedKinds.has(drawing ? 'drawing' : 'text') ? 1 : 0,
          },
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

test('deletion requires confirmation, preserves the monitor on failure and removes it after success', async () => {
  const { client, view } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  const confirmation = within(
    screen.getByRole('alertdialog', { name: 'Delete temporary monitor?' })
  )
  fireEvent.click(confirmation.getByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
  expect(api.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: 'delete' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  failProbeSave = true
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'delete' })
    )
  )
  await waitFor(() =>
    expect(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      })
    ).toBeEnabled()
  )
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  failProbeSave = false
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )
  await screen.findByText('No checks to display')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('editing a running monitor reuses its key and submits independent settings and prompts', async () => {
  const { client, view } = setup()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Edit configuration' })
  )
  await screen.findByLabelText('Base URL')
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Edit configuration' })
  )
  await dialog.findByLabelText('Base URL')
  expect(dialog.getByLabelText('API key')).toHaveValue('')
  expect(dialog.getByLabelText('Drawing reasoning effort')).toHaveValue('high')
  expect(dialog.getByLabelText('Probe reasoning effort')).toHaveValue('low')
  fireEvent.click(dialog.getByRole('button', { name: 'Fetch models' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/degradation_watch/temporary-monitors/1/models',
      })
    )
  )
  fireEvent.change(dialog.getByLabelText('Model'), {
    target: { value: 'replacement-model' },
  })
  fireEvent.change(dialog.getByLabelText('Text probe prompt'), {
    target: { value: 'updated question' },
  })
  fireEvent.change(dialog.getByLabelText('Expected answer'), {
    target: { value: 'updated answer' },
  })
  failProbeSave = true
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'put' })
    )
  )
  await waitFor(() =>
    expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
  )
  expect(dialog.getByLabelText('Text probe prompt')).toHaveValue(
    'updated question'
  )
  failProbeSave = false
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(api.request).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'put',
      data: expect.objectContaining({
        model: 'replacement-model',
        api_key: '',
        text_effort: 'low',
        drawing_effort: 'high',
        text_prompt: 'updated question',
        text_expected: 'updated answer',
        restart: false,
      }),
    })
  )
  view.unmount()
  client.clear()
})

test('restarting a stopped monitor requires a new key and keeps the same monitor ID', async () => {
  monitors = [{ ...monitor, status: 'stopped' }]
  const { client, view } = setup()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Restart monitoring' })
  )
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Restart monitoring' })
  )
  await dialog.findByLabelText('API key')
  fireEvent.click(dialog.getByRole('button', { name: 'Save and restart' }))
  expect(api.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: 'put' })
  )
  fireEvent.change(dialog.getByLabelText('API key'), {
    target: { value: 'replacement-key' },
  })
  fireEvent.click(dialog.getByRole('button', { name: 'Save and restart' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(api.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: '/api/degradation_watch/temporary-monitors/1',
      method: 'put',
      data: expect.objectContaining({
        restart: true,
        api_key: 'replacement-key',
      }),
    })
  )
  await screen.findByRole('button', { name: 'Stop' })
  view.unmount()
  client.clear()
})

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
  const textSchedule = within(
    dialog.getByRole('region', { name: 'Text probes' })
  )
  const drawingSchedule = within(
    dialog.getByRole('region', { name: 'Drawing checks' })
  )
  fireEvent.change(textSchedule.getByLabelText('Interval (minutes)'), {
    target: { value: '7' },
  })
  await userEvent.click(
    drawingSchedule.getByRole('switch', { name: 'Automatic checks' })
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
        text_probe: { enabled: true, interval_minutes: 7 },
        drawing_probe: { enabled: false, interval_minutes: 10 },
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

test('each probe saves its schedule independently and can run once while automatic checks are off', async () => {
  const { view, client } = setup()
  const text = within(
    await screen.findByRole('region', { name: 'Text probes' })
  )
  const drawing = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  const interval = await text.findByLabelText('Interval (minutes)')
  expect(interval).toHaveValue(3)
  expect(drawing.getByLabelText('Interval (minutes)')).toHaveValue(10)
  fireEvent.change(interval, { target: { value: '0' } })
  fireEvent.click(text.getByRole('button', { name: 'Save' }))
  expect(await text.findByRole('alert')).toHaveTextContent('Enter an interval')
  expect(api.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: 'post' })
  )
  fireEvent.change(interval, { target: { value: '7' } })
  await userEvent.click(text.getByRole('switch', { name: 'Automatic checks' }))
  expect(text.getByRole('button', { name: 'Run once' })).toBeDisabled()
  fireEvent.click(text.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(text.getByRole('button', { name: 'Save' })).toBeDisabled()
  )
  expect(api.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: '/api/degradation_watch/temporary-monitors/1/probes/text',
      method: 'post',
      data: { enabled: false, interval_minutes: 7 },
    })
  )
  expect(
    drawing.getByRole('switch', { name: 'Automatic checks' })
  ).toBeChecked()
  expect(drawing.getByLabelText('Interval (minutes)')).toHaveValue(10)
  await waitFor(() =>
    expect(text.getByRole('button', { name: 'Run once' })).toBeEnabled()
  )
  fireEvent.click(text.getByRole('button', { name: 'Run once' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/degradation_watch/temporary-monitors/1/probes/text/run',
        method: 'post',
      })
    )
  )
  await waitFor(() =>
    expect(text.getByRole('button', { name: 'Run once' })).toBeDisabled()
  )
  expect(drawing.getByRole('button', { name: 'Run once' })).toBeEnabled()
  fireEvent.click(drawing.getByRole('button', { name: 'Run once' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/degradation_watch/temporary-monitors/1/probes/drawing/run',
        method: 'post',
      })
    )
  )
  await waitFor(() =>
    expect(drawing.getByRole('button', { name: 'Run once' })).toBeDisabled()
  )
  view.unmount()
  client.clear()
})

test('ended monitors disable probe editing and manual execution', async () => {
  monitors = [{ ...monitor, status: 'completed' }]
  const { view, client } = setup()
  const text = within(
    await screen.findByRole('region', { name: 'Text probes' })
  )
  expect(
    await text.findByRole('switch', { name: 'Automatic checks' })
  ).toHaveAttribute('aria-disabled', 'true')
  expect(text.getByRole('button', { name: 'Run once' })).toBeDisabled()
  expect(text.getByLabelText('Interval (minutes)')).toBeDisabled()
  view.unmount()
  client.clear()
})

test('a failed schedule save preserves the draft and allows retry', async () => {
  failProbeSave = true
  const { view, client } = setup()
  const text = within(
    await screen.findByRole('region', { name: 'Text probes' })
  )
  const interval = await text.findByLabelText('Interval (minutes)')
  fireEvent.change(interval, { target: { value: '9' } })
  fireEvent.click(text.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post' })
    )
  )
  await waitFor(() =>
    expect(text.getByRole('button', { name: 'Save' })).toBeEnabled()
  )
  expect(interval).toHaveValue(9)
  expect(monitors[0].text_interval_minutes).toBe(3)
  expect(text.getByRole('button', { name: 'Run once' })).toBeDisabled()
  failProbeSave = false
  fireEvent.click(text.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(text.getByRole('button', { name: 'Save' })).toBeDisabled()
  )
  expect(monitors[0].text_interval_minutes).toBe(9)
  view.unmount()
  client.clear()
})

test('running monitors save text and drawing prompts independently and preserve failed drafts', async () => {
  queuedKinds = new Set(['text', 'drawing'])
  const { view, client } = setup()
  for (const kind of ['Text probes', 'Drawing checks']) {
    const section = within(await screen.findByRole('region', { name: kind }))
    expect(
      await section.findByRole('button', { name: 'Run once' })
    ).toBeDisabled()
    fireEvent.click(
      await section.findByRole('button', { name: 'Edit probe prompt' })
    )
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Edit probe prompt' })
    )
    fireEvent.change(dialog.getByLabelText('Prompt'), {
      target: { value: `Updated ${kind}` },
    })
    if (kind === 'Text probes') {
      fireEvent.change(dialog.getByLabelText('Blue answer (intermediate)'), {
        target: { value: 'Secondary answer' },
      })
      fireEvent.change(dialog.getByLabelText('Expected answer'), {
        target: { value: 'Updated answer' },
      })
      failProbeSave = true
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(api.request).toHaveBeenCalledWith(
          expect.objectContaining({
            url: '/api/degradation_watch/temporary-monitors/1/probes/text/prompt',
            data: expect.objectContaining({
              intermediate_expected: 'Secondary answer',
            }),
          })
        )
      )
      await waitFor(() =>
        expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
      )
      expect(dialog.getByLabelText('Prompt')).toHaveValue('Updated Text probes')
      expect(dialog.getByLabelText('Blue answer (intermediate)')).toHaveValue(
        'Secondary answer'
      )
      expect(monitors[0].text_prompt).toBe(monitor.text_prompt)
      failProbeSave = false
    }
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  }
  expect(monitors[0].text_prompt).toBe('Updated Text probes')
  expect(monitors[0].text_expected).toBe('Updated answer')
  expect(monitors[0].drawing_prompt).toBe('Updated Drawing checks')
  view.unmount()
  client.clear()
})

test('drawing details show rewrite usage and the immutable actual input', async () => {
  const { view, client } = setup()
  const drawing = within(
    await screen.findByRole('region', { name: 'Drawing checks' })
  )
  fireEvent.click(
    (await drawing.findAllByRole('button', { name: 'Prompt rewrite' }))[0]
  )
  const rewrite = within(
    await screen.findByRole('dialog', { name: 'Prompt rewrite' })
  )
  expect(await rewrite.findByText('Draw a turtle in SVG')).toBeInTheDocument()
  expect(
    rewrite.getByRole('button', { name: 'Input tokens: 123' })
  ).toBeInTheDocument()
  fireEvent.click(rewrite.getByRole('button', { name: 'Close' }))
  fireEvent.click(
    (await drawing.findAllByRole('button', { name: 'View input details' }))[0]
  )
  expect(await screen.findByText('Historical actual input')).toBeInTheDocument()
  expect(screen.queryByText(monitor.drawing_prompt)).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('dedicated rewrite model retains its saved key and discovers models through its own endpoint', async () => {
  const { view, client } = setup()
  fireEvent.click(
    screen.getByRole('button', { name: 'Configure rewrite model' })
  )
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Configure rewrite model' })
  )
  expect(await dialog.findByLabelText('API key')).toHaveValue('')
  fireEvent.click(dialog.getByRole('button', { name: 'Fetch models' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/degradation_watch/temporary-monitors/rewriter/models',
        method: 'post',
        data: expect.objectContaining({
          base_url: 'https://rewrite.example.com/v1',
          api_key: '',
        }),
      })
    )
  )
  fireEvent.change(dialog.getByLabelText('Model'), {
    target: { value: 'replacement-model' },
  })
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(rewriter.model).toBe('replacement-model')
  expect(monitors[0].model).toBe('trial-model')
  view.unmount()
  client.clear()
})
