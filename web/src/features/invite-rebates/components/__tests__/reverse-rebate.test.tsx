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
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { useEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { INVITE_REBATE_STATUS } from '../../constants'
import type { InviteRebate } from '../../types'
import { useInviteRebatesColumns } from '../invite-rebates-columns'
import {
  InviteRebatesProvider,
  useInviteRebates,
} from '../invite-rebates-provider'
import { ReverseRebateDialog } from '../reverse-rebate-dialog'

// The locale bundle is intentionally empty, so every t('...') resolves to its
// own English key — interpolated with the values the component passes in.
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

function makeRebate(overrides: Partial<InviteRebate> = {}): InviteRebate {
  return {
    id: 7,
    inviter_id: 2,
    inviter_name: 'alice',
    invitee_id: 3,
    invitee_name: 'bob',
    source: 'epay',
    source_ref: '',
    base_quota: 500000,
    rate_basis_points: 1000,
    rebate_quota: 50000,
    outstanding_quota: 50000,
    status: INVITE_REBATE_STATUS.CREDITED,
    skip_reason: '',
    reversed_quota: 0,
    reversed_at: 0,
    reversed_by: 0,
    reverse_reason: '',
    created_at: 1700000000,
    ...overrides,
  }
}

const creditedRow = makeRebate()

const clients: QueryClient[] = []

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

/** Opens the dialog on `row` and exposes the provider's refresh counter. */
function SeedRow(props: { row: InviteRebate | null }) {
  const { setReversingRow, refreshTrigger } = useInviteRebates()
  useEffect(() => {
    setReversingRow(props.row)
  }, [props.row, setReversingRow])
  return <span data-testid='refresh-trigger'>{refreshTrigger}</span>
}

function renderDialog(row: InviteRebate | null = creditedRow) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <InviteRebatesProvider>
          <SeedRow row={row} />
          <ReverseRebateDialog />
        </InviteRebatesProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

it('requires a reason and sends it trimmed with the rebate id', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderDialog()

  const dialog = await screen.findByRole('dialog')
  // The copy names the inviter and how much is clawed back from their balance.
  expect(
    within(dialog).getByText(/credited to alice is deducted from their balance/)
  ).toBeInTheDocument()

  const confirm = within(dialog).getByRole('button', {
    name: 'Reverse Rebate',
  })
  expect(confirm).toBeDisabled()

  const reason = within(dialog).getByLabelText('Reason')
  await user.type(reason, '   ')
  expect(confirm).toBeDisabled()
  expect(post).not.toHaveBeenCalled()

  await user.type(reason, '  charged back  ')
  await user.click(confirm)

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/invite_rebate/reverse', {
      id: creditedRow.id,
      reason: 'charged back',
    })
  )
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('refresh-trigger')).toHaveTextContent('1')
})

it('keeps the reason and the dialog when the reversal fails', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'rebate has already been reversed' },
  })
  const user = userEvent.setup()
  renderDialog()

  const dialog = await screen.findByRole('dialog')
  const reason = within(dialog).getByLabelText('Reason')
  await user.type(reason, 'duplicate request')
  await user.click(
    within(dialog).getByRole('button', { name: 'Reverse Rebate' })
  )

  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Reverse Rebate' })
    ).toBeEnabled()
  )
  expect(reason).toHaveValue('duplicate request')
  expect(screen.getByTestId('refresh-trigger')).toHaveTextContent('0')
})

function ColumnsHarness(props: { rebates: InviteRebate[] }) {
  const columns = useInviteRebatesColumns()
  const table = useReactTable({
    columns,
    data: props.rebates,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <TooltipProvider>
      <InviteRebatesProvider>
        <table>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </InviteRebatesProvider>
    </TooltipProvider>
  )
}

function renderColumns(rebates: InviteRebate[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ColumnsHarness rebates={rebates} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

it('only offers the reversal while a credited rebate still holds an amount', async () => {
  renderColumns([
    creditedRow,
    makeRebate({ id: 8, reversed_quota: 50000, outstanding_quota: 0 }),
    makeRebate({
      id: 9,
      status: INVITE_REBATE_STATUS.SKIPPED,
      skip_reason: 'inviter_wallet_limit',
      rebate_quota: 0,
      outstanding_quota: 0,
    }),
  ])

  const rows = screen.getAllByRole('row')
  expect(
    within(rows[0]).getByRole('button', { name: 'Open menu' })
  ).toBeInTheDocument()
  // Fully clawed back and never-credited rows have nothing left to reverse.
  expect(within(rows[1]).getByText('—')).toBeInTheDocument()
  expect(within(rows[2]).getByText('—')).toBeInTheDocument()
})
