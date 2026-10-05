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
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    const data: Record<string, unknown> = {
      '/api/degradation_watch/probe-plan': {
        ...structuredClone(plan),
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

test('selecting a public channel replaces the previous selection and saves one complete plan', async () => {
  const { view, client, user } = setup()
  const publicSwitches = await screen.findAllByRole('switch', {
    name: 'Show on public wall',
  })
  expect(publicSwitches[0]).toBeChecked()
  await user.click(publicSwitches[1])
  expect(publicSwitches[0]).not.toBeChecked()
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
          expect.objectContaining({ public: false }),
          expect.objectContaining({ public: true }),
        ],
      })
    )
  )
  view.unmount()
  client.clear()
})

test('changing group immediately updates channel and model choices and clears public selection', async () => {
  const { view, client, user } = setup()
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
    screen.getAllByRole('switch', { name: 'Show on public wall' })[0]
  ).not.toBeChecked()
  view.unmount()
  client.clear()
})
