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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { ProbePlan } from '@/features/degradation-watch/lib/probes'
import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { ProbeSettingsSection } from '../probe-settings-section'

const plan: ProbePlan = {
  enabled: true,
  concurrency: 2,
  timeout_seconds: 1200,
  probes: [
    {
      id: 'sanae',
      name: 'Sanae',
      kind: 'text',
      prompt: 'Prompt',
      expected: 'Answer',
      match: 'exact',
      interval_minutes: 5,
    },
  ],
  targets: [1, 2].map((id) => ({
    group: 'alpha',
    channel_id: id,
    model: 'sol',
    reasoning_effort: '',
    enabled: true,
    public: id === 1,
    probes: [{ probe_id: 'sanae', enabled: true, interval_minutes: 0 }],
  })),
}
const channels = [
  { id: 1, name: 'One', groups: ['alpha'], models: ['sol'], status: 1 },
  {
    id: 2,
    name: 'Two',
    groups: ['alpha', 'beta'],
    models: ['sol', 'astra'],
    status: 1,
  },
]
let configured = true
let currentGroups = ['alpha', 'beta']
let groupsFailed = false
let testPlan = plan

function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <ProbeSettingsSection />
      </SettingsPageProvider>
    </>
  )
}

beforeEach(() => {
  configured = true
  currentGroups = ['alpha', 'beta']
  groupsFailed = false
  testPlan = plan
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/group/' && groupsFailed) {
      return { data: { success: false, message: 'Groups unavailable' } }
    }
    const data: Record<string, unknown> = {
      '/api/group/': currentGroups,
      '/api/degradation_watch/probe-plan': {
        ...structuredClone(testPlan),
        configured,
      },
      '/api/degradation_watch/channels': {
        available_channels: channels,
        targets: [],
        channels: [],
      },
      '/api/degradation_watch/monitor': { lanes: [] },
      '/api/degradation_watch/activity': { task: null, records: [] },
    }
    if (!(url in data)) throw new Error(`Unexpected ${url}`)
    return { data: { success: true, data: data[url] } }
  })
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
  vi.spyOn(api, 'post').mockResolvedValue({ data: { success: true } })
})

test('each probe button runs only its own template on the selected channel and the row action still runs all its probes', async () => {
  testPlan = structuredClone(plan)
  testPlan.probes.push(
    { ...plan.probes[0], id: 'other', name: 'Other text' },
    { ...plan.probes[0], id: 'drawing', name: 'Drawing', kind: 'drawing' }
  )
  testPlan.targets[1].probes.push(
    { probe_id: 'other', enabled: true, interval_minutes: 0 },
    { probe_id: 'drawing', enabled: true, interval_minutes: 0 }
  )
  const { view, client, user } = setup()
  await screen.findByRole('button', { name: 'Run Drawing now' })
  const row = screen.getByRole('row', { name: /Two/ })
  for (const [name, id] of [
    ['Sanae', 'sanae'],
    ['Other text', 'other'],
    ['Drawing', 'drawing'],
  ]) {
    const button = within(row).getByRole('button', { name: `Run ${name} now` })
    await user.click(button)
    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith(
        '/api/degradation_watch/probe-run',
        { group: 'alpha', model: 'sol', channel_id: 2, probe_id: id }
      )
    )
    await waitFor(() => expect(button).toBeEnabled())
  }
  await user.click(within(row).getByRole('button', { name: 'Run now' }))
  await waitFor(() =>
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/degradation_watch/probe-run',
      { group: 'alpha', model: 'sol', channel_id: 2 }
    )
  )
  expect(api.post).toHaveBeenCalledTimes(4)
  view.unmount()
  client.clear()
})

test('individual probe buttons prevent duplicate submissions and stay disabled for disabled targets or unsaved edits', async () => {
  testPlan = structuredClone(plan)
  testPlan.targets[1].enabled = false
  let finish = () => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  vi.mocked(api.post).mockImplementationOnce(async () => {
    await pending
    return { data: { success: true } }
  })
  const { view, client, user } = setup()
  const buttons = await screen.findAllByRole('button', {
    name: 'Run Sanae now',
  })
  expect(buttons[1]).toBeDisabled()
  await user.click(buttons[0])
  await waitFor(() => expect(buttons[0]).toBeDisabled())
  await user.click(buttons[0])
  expect(api.post).toHaveBeenCalledTimes(1)
  finish()
  await waitFor(() => expect(buttons[0]).toBeEnabled())
  await user.click(
    screen.getAllByRole('switch', { name: /Show .+ on public wall/ })[0]
  )
  expect(buttons[0]).toBeDisabled()
  expect(buttons[1]).toBeDisabled()
  view.unmount()
  client.clear()
})

test('deleted groups from channel bindings and old targets do not appear, while valid empty groups remain selectable', async () => {
  currentGroups = ['beta', 'empty']
  const { view, client, user } = setup()
  await screen.findByRole('button', { name: 'Add target' })
  expect(
    screen.queryByRole('button', { name: /^alpha/ })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^beta/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^empty/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Add target' }))
  const group = screen.getByRole('combobox', { name: 'Group' })
  expect(
    within(group).queryByRole('option', { name: 'alpha' })
  ).not.toBeInTheDocument()
  expect(
    within(group).getByRole('option', { name: 'empty' })
  ).toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('refresh removes a deleted selected group without discarding unsaved target edits', async () => {
  const { view, client, user } = setup()
  await user.click(
    (
      await screen.findAllByRole('switch', { name: /Show .+ on public wall/ })
    )[0]
  )
  currentGroups = ['beta']
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /^alpha/ })
    ).not.toBeInTheDocument()
  )
  expect(screen.getByRole('button', { name: /^beta/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        targets: [
          {
            ...plan.targets[0],
            probes: [{ ...plan.targets[0].probes[0], public: false }],
          },
          plan.targets[1],
        ],
      })
    )
  )
  view.unmount()
  client.clear()
})

test('a migrated legacy plan can be saved without edits and cannot run until saved', async () => {
  configured = false
  const { view, client, user } = setup()
  const save = await screen.findByRole('button', {
    name: 'Save degradation watch settings',
  })
  expect(save).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Run all checks' })).toBeDisabled()
  await user.click(save)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run all checks' })).toBeEnabled()
  )
  expect(api.put).toHaveBeenCalledWith(
    '/api/degradation_watch/probe-plan',
    plan
  )
  view.unmount()
  client.clear()
})

test('an empty current group catalog disables adding targets even if channels retain old bindings', async () => {
  currentGroups = []
  const { view, client } = setup()
  expect(
    await screen.findByRole('button', { name: 'Add target' })
  ).toBeDisabled()
  expect(
    screen.queryByRole('button', { name: /^alpha/ })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /^beta/ })
  ).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

test('a group catalog failure offers retry without falling back to stale channel groups', async () => {
  groupsFailed = true
  const { view, client, user } = setup()
  await screen.findByRole('button', { name: 'Retry' })
  expect(
    screen.queryByRole('button', { name: 'Add target' })
  ).not.toBeInTheDocument()
  groupsFailed = false
  currentGroups = ['beta']
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: /^beta/ })
  expect(
    screen.queryByRole('button', { name: /^alpha/ })
  ).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>
  )
  return { view, client, user: userEvent.setup() }
}

test('showing another channel preserves existing public probes and saves independent visibility', async () => {
  const { view, client, user } = setup()
  const publicSwitches = await screen.findAllByRole('switch', {
    name: /Show .+ on public wall/,
  })
  expect(publicSwitches[0]).toBeChecked()
  await user.click(publicSwitches[1])
  expect(publicSwitches[0]).toBeChecked()
  expect(publicSwitches[1]).toBeChecked()
  expect(screen.getByRole('button', { name: 'Run all checks' })).toBeDisabled()
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        targets: [
          plan.targets[0],
          expect.objectContaining({
            probes: [expect.objectContaining({ public: true })],
          }),
        ],
      })
    )
  )
  view.unmount()
  client.clear()
})

test('text probe visibility and reasoning can change without changing the drawing or another channel', async () => {
  testPlan = structuredClone(plan)
  testPlan.targets[0].reasoning_effort = 'high'
  testPlan.probes.push({
    ...plan.probes[0],
    id: 'drawing',
    name: 'Drawing',
    kind: 'drawing',
  })
  testPlan.targets[0].probes.push({
    probe_id: 'drawing',
    enabled: true,
    interval_minutes: 0,
  })
  const { view, client, user } = setup()
  await user.click(
    (await screen.findAllByRole('button', { name: 'Configure' }))[0]
  )
  const dialog = within(screen.getByRole('dialog'))
  await user.click(
    dialog.getByRole('switch', { name: 'Show Sanae on public wall' })
  )
  expect(
    dialog.getByRole('switch', { name: 'Show Drawing on public wall' })
  ).toBeChecked()
  const effort = dialog.getByRole('combobox', {
    name: 'Probe reasoning effort',
  })
  expect(effort).toHaveValue('inherit')
  await user.selectOptions(effort, 'low')
  expect(
    dialog.getByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveValue('high')
  await user.click(dialog.getByRole('button', { name: 'Apply to form' }))
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            reasoning_effort: 'high',
            probes: [
              expect.objectContaining({
                public: false,
                reasoning_effort: 'low',
              }),
              testPlan.targets[0].probes[1],
            ],
          }),
          testPlan.targets[1],
        ],
      })
    )
  )
  await user.click(screen.getAllByRole('button', { name: 'Configure' })[0])
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Probe reasoning effort' }),
    ''
  )
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenLastCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            probes: [
              expect.objectContaining({ reasoning_effort: '' }),
              testPlan.targets[0].probes[1],
            ],
          }),
          testPlan.targets[1],
        ],
      })
    )
  )
  view.unmount()
  client.clear()
})

test('changing group immediately updates channel and model choices and clears public selection', async () => {
  const { view, client, user } = setup()
  await user.click(
    (await screen.findAllByRole('button', { name: 'Configure' }))[0]
  )
  const groups = await screen.findAllByRole('combobox', { name: 'Group' })
  await user.selectOptions(groups[0], 'beta')
  const channel = screen.getAllByRole('combobox', { name: 'Channel' })[0]
  expect(
    within(channel).queryByRole('option', { name: 'One' })
  ).not.toBeInTheDocument()
  expect(channel).toHaveValue('0')
  await user.selectOptions(channel, '2')
  expect(
    within(screen.getAllByRole('combobox', { name: 'Model' })[0]).getByRole(
      'option',
      { name: 'astra' }
    )
  ).toBeInTheDocument()
  expect(
    screen.getAllByRole('switch', { name: /Show .+ on public wall/ })[0]
  ).not.toBeChecked()
  view.unmount()
  client.clear()
})

test('drawer cancellation keeps the saved plan, applying stages changes, and reset restores it', async () => {
  const { view, client, user } = setup()
  await user.click(
    (await screen.findAllByRole('button', { name: 'Configure' }))[0]
  )
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Reasoning effort' }),
    'high'
  )
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  ).toBeDisabled()
  await user.click(screen.getAllByRole('button', { name: 'Configure' })[0])
  expect(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveValue('')
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Reasoning effort' }),
    'high'
  )
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(api.put).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Run all checks' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  expect(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  ).toBeDisabled()
  await user.click(screen.getAllByRole('button', { name: 'Configure' })[0])
  expect(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveValue('')
  view.unmount()
  client.clear()
})

test('invalid and duplicate target edits stay in the drawer until corrected', async () => {
  const { view, client, user } = setup()
  await user.click(
    (await screen.findAllByRole('button', { name: 'Configure' }))[0]
  )
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Channel' }),
    '2'
  )
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Check the target selection and public channel'
  )
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Model' }),
    'sol'
  )
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Model' }),
    'astra'
  )
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            model: 'astra',
            channel_id: 2,
            public: false,
          }),
          plan.targets[1],
        ],
      })
    )
  )
  view.unmount()
  client.clear()
})

test('template deletion removes bindings atomically and run history only loads when opened', async () => {
  const { view, client, user } = setup()
  await screen.findByRole('button', { name: 'Run all checks' })
  expect(
    vi
      .mocked(api.get)
      .mock.calls.some(
        ([url]) => url.endsWith('/activity') || url.endsWith('/monitor')
      )
  ).toBe(false)
  await user.click(screen.getByRole('tab', { name: 'Probe templates' }))
  await user.click(screen.getByRole('button', { name: 'Remove' }))
  const confirmation = screen.getByRole('alertdialog')
  await user.click(within(confirmation).getByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        probes: [],
        targets: plan.targets.map((target) => ({ ...target, probes: [] })),
      })
    )
  )
  await user.click(screen.getByRole('tab', { name: 'Run history' }))
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith('/api/degradation_watch/activity')
  )
  view.unmount()
  client.clear()
})

test('template and runtime dialogs validate edits before staging and saving', async () => {
  const { view, client, user } = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Runtime settings' })
  )
  const timeout = screen.getByRole('spinbutton', {
    name: 'Request timeout (seconds)',
  })
  await user.clear(timeout)
  await user.type(timeout, '10')
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  await user.clear(timeout)
  await user.type(timeout, '1800')
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  await user.click(screen.getByRole('tab', { name: 'Probe templates' }))
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  await user.clear(prompt)
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  await user.type(prompt, 'Updated prompt')
  await user.click(screen.getByRole('button', { name: 'Apply to form' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(api.put).not.toHaveBeenCalled()
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/api/degradation_watch/probe-plan',
      expect.objectContaining({
        timeout_seconds: 1800,
        probes: [{ ...plan.probes[0], prompt: 'Updated prompt' }],
      })
    )
  )
  view.unmount()
  client.clear()
})

test('a failed save retains the draft for retry', async () => {
  const { view, client, user } = setup()
  vi.mocked(api.put).mockRejectedValueOnce(new Error('Save failed'))
  await user.click(
    (
      await screen.findAllByRole('switch', { name: /Show .+ on public wall/ })
    )[1]
  )
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save degradation watch settings' })
    ).toBeEnabled()
  )
  expect(
    screen.getAllByRole('switch', { name: /Show .+ on public wall/ })[1]
  ).toBeChecked()
  expect(screen.getByRole('button', { name: 'Run all checks' })).toBeDisabled()
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run all checks' })).toBeEnabled()
  )
  expect(api.put).toHaveBeenCalledTimes(2)
  view.unmount()
  client.clear()
})
