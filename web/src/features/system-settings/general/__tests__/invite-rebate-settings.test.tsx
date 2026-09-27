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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { InviteRebateSettingsSection } from '../invite-rebate-settings-section'

const SAVE_LABEL = 'Save invite rebate settings'
const DIRECT_LABEL = 'Internal member rate (%)'
const EXTERNAL_LABEL = 'External user rate (%)'
const UPLINE_LABEL = 'Upline member rate (%)'
const TOGGLE_LABEL = 'Enable invite rebate'

type Defaults = {
  enabled: boolean
  rateBasisPoints: number
  externalRateBasisPoints: number
  internalReferrerRateBasisPoints: number
}

const DEFAULTS: Defaults = {
  enabled: true,
  rateBasisPoints: 1000,
  externalRateBasisPoints: 100,
  internalReferrerRateBasisPoints: 100,
}

function Fixture(props: Partial<Defaults>) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <InviteRebateSettingsSection
          defaultValues={{ ...DEFAULTS, ...props }}
        />
      </SettingsPageProvider>
    </>
  )
}

async function renderSection(props: Partial<Defaults> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Fixture {...props} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  // The rate inputs only exist while the rebate is enabled, so wait on the
  // toggle and let each case query the fields it cares about.
  await screen.findByRole('switch', { name: TOGGLE_LABEL })
}

function saveButton() {
  return screen.getByRole('button', { name: SAVE_LABEL })
}

function rateInput(label: string) {
  return screen.getByRole('spinbutton', { name: label })
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

// The stored rate is integer basis points while the form shows percent; a
// rounding mistake here would quietly pay out a different share than the
// administrator typed.
test('a rate typed as percent is saved as basis points', async () => {
  const user = userEvent.setup()
  await renderSection({ rateBasisPoints: 1000 })
  const input = rateInput(DIRECT_LABEL)
  expect(input).toHaveValue(10)

  await user.clear(input)
  await user.type(input, '12.5')
  await user.tab()
  expect(input).toHaveValue(12.5)
  await user.click(saveButton())

  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'invite_rebate_setting.rate_basis_points',
      value: '1250',
    })
  )
})

// The three legs are independent settings; editing one must not push the other
// two back at the server, or a stale value in the form would silently overwrite
// a rate another administrator just changed.
test('editing one rate saves only that rate', async () => {
  const user = userEvent.setup()
  await renderSection()
  const external = rateInput(EXTERNAL_LABEL)
  expect(external).toHaveValue(1)
  expect(rateInput(UPLINE_LABEL)).toHaveValue(1)

  await user.clear(external)
  await user.type(external, '2.5')
  await user.tab()
  await user.click(saveButton())

  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
  expect(api.put).toHaveBeenCalledWith('/api/option/', {
    key: 'invite_rebate_setting.external_rate_basis_points',
    value: '250',
  })
})

test('the upline rate saves under its own option key', async () => {
  const user = userEvent.setup()
  await renderSection()
  const upline = rateInput(UPLINE_LABEL)

  await user.clear(upline)
  await user.type(upline, '3')
  await user.tab()
  await user.click(saveButton())

  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'invite_rebate_setting.internal_referrer_rate_basis_points',
      value: '300',
    })
  )
})

// An untouched form must not write: a spurious save would show up as a change
// in the option history for no reason.
test('an untouched form cannot be saved', async () => {
  await renderSection({ rateBasisPoints: 1000 })
  expect(saveButton()).toBeDisabled()
  expect(api.put).not.toHaveBeenCalled()
})

test('turning the rebate off saves the boolean as a string', async () => {
  const user = userEvent.setup()
  await renderSection({ enabled: true })
  await user.click(screen.getByRole('switch', { name: TOGGLE_LABEL }))
  await user.click(saveButton())

  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'invite_rebate_setting.enabled',
      value: 'false',
    })
  )
})

test('the rate fields are hidden while the rebate is disabled', async () => {
  await renderSection({ enabled: false })
  for (const label of [DIRECT_LABEL, EXTERNAL_LABEL, UPLINE_LABEL]) {
    expect(screen.queryByRole('spinbutton', { name: label })).toBeNull()
  }
})
