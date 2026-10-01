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

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { DegradationWatchSettingsSection } from '../degradation-watch-settings-section'

const defaults = {
  enabled: true,
  targets: [
    {
      group: 'alpha',
      model: 'model-a',
      reasoningEffort: 'medium',
      enabled: true,
    },
  ],
  intervalMinutes: 30,
  timeoutSeconds: 600,
  retentionPerChannel: 200,
  concurrency: 4,
  prompt: '',
}

const catalog = [
  {
    id: 1,
    name: 'Alpha channel',
    status: 1,
    groups: ['alpha'],
    models: ['model-a', 'shared'],
  },
  {
    id: 2,
    name: 'Beta channel',
    status: 1,
    groups: ['beta'],
    models: ['model-b', 'shared'],
  },
  {
    id: 3,
    name: 'Disabled channel',
    status: 2,
    groups: ['beta'],
    models: ['disabled-model'],
  },
]

let inventory = catalog

function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <DegradationWatchSettingsSection
          defaultValues={defaults}
          aliasesJson='{"1":"Alpha"}'
        />
      </SettingsPageProvider>
    </>
  )
}

async function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>
  )
  await screen.findByText('#1 Alpha channel')
  return client
}

beforeEach(() => {
  inventory = structuredClone(catalog)
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/group/') {
      return { data: { success: true, data: ['alpha', 'beta', 'empty'] } }
    }
    if (url === '/api/degradation_watch/channels') {
      return {
        data: {
          success: true,
          data: {
            targets: [],
            available_channels: inventory,
            channels: [
              {
                id: 1,
                name: 'Alpha channel',
                status: 1,
                alias: 'Alpha',
                models: ['model-a'],
                last_record_at: 0,
              },
            ],
          },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: { task_id: 'run-1', status: 'pending' } },
  })
})

test('changing a group immediately replaces its model options and clears an incompatible selection', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Group' }),
    'beta'
  )
  const models = screen.getByRole('combobox', { name: 'Model' })
  expect(
    within(models).queryByRole('option', { name: 'model-a' })
  ).not.toBeInTheDocument()
  expect(
    within(models).getByRole('option', { name: 'model-b' })
  ).toBeInTheDocument()
  expect(
    within(models).queryByRole('option', { name: 'disabled-model' })
  ).not.toBeInTheDocument()
  expect(models).toHaveValue('')
})

test('channel preview follows unsaved groups and prevents running the previous saved target', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Group' }),
    'beta'
  )
  expect(screen.queryByText('#1 Alpha channel')).not.toBeInTheDocument()
  expect(screen.getByText('#2 Beta channel')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Run all now' })).toBeDisabled()
  expect(api.put).not.toHaveBeenCalled()
})

test('changing groups retains a model supported by both groups', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Model' }),
    'shared'
  )
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Group' }),
    'beta'
  )
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('shared')
  expect(
    screen.getByRole('button', { name: 'Run shared on this channel now' })
  ).toBeDisabled()
})

test('an empty group shows no models or channels and cannot save an empty model', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Group' }),
    'empty'
  )
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
  expect(
    screen.getByText('No available models in this group')
  ).toBeInTheDocument()
  expect(
    screen.getByText('No channels in the groups of the configured models')
  ).toBeInTheDocument()
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  expect(api.put).not.toHaveBeenCalled()
})

test('saving draft targets and aliases together enables running the saved model and clears dirty state', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Group' }),
    'beta'
  )
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Model' }),
    'model-b'
  )
  await user.type(
    screen.getByRole('textbox', { name: 'Alias #2' }),
    'Beta display'
  )
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save degradation watch settings' })
    ).toBeDisabled()
  )
  expect(api.put).toHaveBeenCalledWith('/api/option/', {
    key: 'degradation_watch_setting.targets',
    value: JSON.stringify([
      {
        model: 'model-b',
        group: 'beta',
        reasoning_effort: 'medium',
        enabled: true,
      },
    ]),
  })
  expect(api.put).toHaveBeenCalledWith('/api/option/', {
    key: 'degradation_watch_setting.channel_aliases',
    value: JSON.stringify({ '1': 'Alpha', '2': 'Beta display' }),
  })
  await user.click(
    screen.getByRole('button', { name: 'Run model-b on this channel now' })
  )
  expect(api.post).toHaveBeenCalledWith(
    '/api/degradation_watch/run',
    { channel_id: 2, model: 'model-b' },
    expect.anything()
  )
  // A second save compares with the last successful save, even before parent props refresh.
  await user.clear(screen.getByRole('textbox', { name: 'Alias #2' }))
  await user.type(
    screen.getByRole('textbox', { name: 'Alias #2' }),
    'Beta renamed'
  )
  vi.mocked(api.put).mockClear()
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save degradation watch settings' })
    ).toBeDisabled()
  )
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(api.put).toHaveBeenCalledWith('/api/option/', {
    key: 'degradation_watch_setting.channel_aliases',
    value: JSON.stringify({ '1': 'Alpha', '2': 'Beta renamed' }),
  })
})

test('refreshing live channels updates names, status and model choices without discarding alias edits', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.type(screen.getByRole('textbox', { name: 'Alias #1' }), ' edited')
  inventory = [
    {
      ...catalog[0],
      name: 'Renamed channel',
      status: 2,
      models: ['new-model'],
    },
  ]
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('#1 Renamed channel')
  expect(screen.getByRole('textbox', { name: 'Alias #1' })).toHaveValue(
    'Alpha edited'
  )
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
  expect(
    screen.getByText('This model is unavailable in the selected group')
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Run model-a on this channel now' })
  ).not.toBeInTheDocument()
})

test('a channel refresh failure hides stale actions and allows retry without losing form edits', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.type(screen.getByRole('textbox', { name: 'Alias #1' }), ' edited')
  vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Failed to load channels')
  expect(screen.getByRole('button', { name: 'Run all now' })).toBeDisabled()
  expect(screen.queryByText('#1 Alpha channel')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('#1 Alpha channel')
  expect(screen.getByRole('textbox', { name: 'Alias #1' })).toHaveValue(
    'Alpha edited'
  )
})

test('a failed settings save retains the draft and keeps run actions disabled until retry succeeds', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.type(screen.getByRole('textbox', { name: 'Alias #1' }), ' edited')
  vi.mocked(api.put).mockResolvedValueOnce({
    data: { success: false, message: 'Save rejected' },
  })
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save degradation watch settings' })
    ).toBeEnabled()
  )
  expect(screen.getByRole('textbox', { name: 'Alias #1' })).toHaveValue(
    'Alpha edited'
  )
  expect(screen.getByRole('button', { name: 'Run all now' })).toBeDisabled()
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run all now' })).toBeEnabled()
  )
})

test('target labels stay associated after reordering and each row keeps its own group and model', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.click(screen.getByRole('button', { name: 'Add model' }))
  await user.selectOptions(
    screen.getAllByRole('combobox', { name: 'Group' })[1],
    'beta'
  )
  await user.selectOptions(
    screen.getAllByRole('combobox', { name: 'Model' })[1],
    'model-b'
  )
  await user.click(screen.getAllByRole('button', { name: 'Move up' })[1])
  expect(screen.getAllByRole('combobox', { name: 'Group' })[0]).toHaveValue(
    'beta'
  )
  expect(screen.getAllByRole('combobox', { name: 'Model' })[0]).toHaveValue(
    'model-b'
  )
  expect(screen.getAllByRole('combobox', { name: 'Model' })[1]).toHaveValue(
    'model-a'
  )
  const parameters = screen.getByRole('group', { name: 'Run parameters' })
  expect(
    within(parameters).getByRole('spinbutton', { name: 'Concurrent requests' })
  ).toHaveValue(4)
  await user.click(screen.getAllByRole('button', { name: 'Remove' })[0])
  expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('alpha')
  expect(screen.queryByText('#2 Beta channel')).not.toBeInTheDocument()
})

test('removing every target cannot silently restore the legacy target on save', async () => {
  const user = userEvent.setup()
  await renderSection()
  await user.click(screen.getByRole('button', { name: 'Remove' }))
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  expect(
    await screen.findByText('Add at least one model to test')
  ).toBeInTheDocument()
  expect(api.put).not.toHaveBeenCalled()
})

test('parameter limits reject out of range values and preserve independently editable fields', async () => {
  const user = userEvent.setup()
  await renderSection()
  const concurrency = screen.getByRole('spinbutton', {
    name: 'Concurrent requests',
  })
  await user.clear(concurrency)
  await user.type(concurrency, '33')
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  expect(concurrency).toHaveAttribute('aria-invalid', 'true')
  expect(api.put).not.toHaveBeenCalled()
  await user.clear(concurrency)
  await user.type(concurrency, '8')
  await user.click(
    screen.getByRole('button', { name: 'Save degradation watch settings' })
  )
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'degradation_watch_setting.concurrency',
      value: '8',
    })
  )
  expect(api.put).toHaveBeenCalledTimes(1)
})
