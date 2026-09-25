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
import { fireEvent, render, screen, within } from '@testing-library/react'
import type React from 'react'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useSystemConfigStore } from '@/stores/system-config-store'

import type { UsageLog } from '../../data/schema'
import type { LogOtherData } from '../../types'
import { useCommonLogsColumns } from '../columns/common-logs-columns'
import { expandTechnicalDetails } from './dialog-helpers'

vi.mock('@lobehub/icons', () => ({}))
vi.hoisted(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
})
afterAll(() => vi.unstubAllGlobals())

/**
 * `quota` and token counts are copied from logs produced by the real settle
 * paths in service/text_quota.go and service/quota.go, so a reconstruction that
 * drifts from the backend stops reconciling here.
 */
function makeLog(
  other: LogOtherData,
  quota = 5000,
  promptTokens = 0,
  completionTokens = 0
): UsageLog {
  return {
    id: 1,
    user_id: 1,
    created_at: 1,
    type: 2,
    content: '',
    username: 'user',
    token_name: 'token',
    model_name: 'wan2.5-i2v-preview',
    quota,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    use_time: 0,
    is_stream: false,
    channel: 1,
    channel_name: '',
    token_id: 1,
    group: 'default',
    ip: '',
    other: JSON.stringify(other),
    request_id: 'req-1',
    upstream_request_id: '',
  }
}

function LogRow(props: { log: UsageLog; isAdmin: boolean }) {
  const table = useReactTable({
    data: [props.log],
    columns: useCommonLogsColumns(props.isAdmin, false),
    getCoreRowModel: getCoreRowModel(),
  })
  const cell = table
    .getRowModel()
    .rows[0].getAllCells()
    .find((item) => item.column.id === 'content')
  if (!cell) throw new Error('The log must have a content column')
  return flexRender(cell.column.columnDef.cell, cell.getContext())
}

const plugin = {
  key: 'incho',
  name: 'Incho',
  version: '1.0.1',
  author: { name: 'Plugin maintainer' },
}

let client: QueryClient
const previousConfig = useSystemConfigStore.getState().config

beforeEach(() => {
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...previousConfig.currency } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['status'], {}, { updatedAt: Date.now() + 60_000 })
  client.setQueryData(
    ['pricing'],
    { data: [], vendors: [] },
    { updatedAt: Date.now() + 60_000 }
  )
})

afterEach(() => {
  client.clear()
  useSystemConfigStore.getState().setConfig(previousConfig)
})

function wrapper(props: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  )
}

/** Renders the details cell and returns the button that opens the dialog. */
function renderRow(log: UsageLog, isAdmin = true) {
  render(<LogRow log={log} isAdmin={isAdmin} />, { wrapper })
  return screen.getByRole('button', { name: 'View details' })
}

async function openDialog(log: UsageLog, isAdmin = true) {
  fireEvent.click(renderRow(log, isAdmin))
  return within(await screen.findByRole('dialog'))
}

test('the details cell is a button that opens the dialog', async () => {
  const dialog = await openDialog(makeLog({ model_price: 0.25 }, 125000))

  // The billing summary used to be inlined in the cell; the table holds the
  // entry point and nothing else.
  expect(dialog.getAllByText('Charged').length).toBeGreaterThan(0)
})

test('the collapsed diagnostics are closed until the reader opens them', async () => {
  const dialog = await openDialog(
    makeLog(
      {
        model_ratio: 1.5,
        completion_ratio: 3,
        group_ratio: 1.2,
        admin_info: {
          task_plugin: plugin,
          reject_reason: 'blocked by channel policy',
        },
      },
      4500,
      1000,
      500
    )
  )

  // Identifiers, plugin, reject reason, token breakdown and billing details.
  expect(
    dialog.getByRole('button', {
      name: 'Technical details, 5 sections',
    })
  ).toBeVisible()
  expect(dialog.queryByText('Reject Reason')).toBeNull()

  fireEvent.click(dialog.getByRole('button', { name: /Technical details/ }))
  expect(dialog.getByText('Reject Reason')).toBeVisible()
  expect(dialog.getByText('Total Cost')).toBeVisible()
})

test('keeps the dialog open when the table refreshes with unchanged data', async () => {
  const log = makeLog({ model_price: 0.25 }, 125000)
  const { rerender } = render(<LogRow log={log} isAdmin />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'View details' }))
  expect(await screen.findByRole('dialog')).toBeVisible()

  rerender(<LogRow log={log} isAdmin />)
  expect(screen.getByRole('dialog')).toBeVisible()
})

test('itemizes a token charge and shows it reconciling with the recorded quota', async () => {
  const dialog = await openDialog(
    makeLog(
      { model_ratio: 1.5, completion_ratio: 3, group_ratio: 1.2 },
      4500,
      1000,
      500
    )
  )

  expect(dialog.getByText('Usage details')).toBeVisible()
  expect(dialog.getByText('1,000 tokens × $3/M × 1.2x')).toBeVisible()
  expect(dialog.getByText('500 tokens × $9/M × 1.2x')).toBeVisible()
  expect(
    dialog.getByText('Computed total').nextElementSibling
  ).toHaveTextContent('$0.009')
  // The terms reach the recorded charge, so there is no difference to explain.
  expect(dialog.queryByText('Difference')).toBeNull()
})

test('states the difference and its cause when the terms do not reach the charge', async () => {
  const dialog = await openDialog(
    makeLog(
      { model_ratio: 1.5, completion_ratio: 3, group_ratio: 1.2 },
      999_999,
      1000,
      500
    )
  )

  expect(dialog.getByText('Difference')).toBeVisible()
  expect(
    dialog.getByText(/The difference comes from a server-side multiplier/)
  ).toBeVisible()
})

test('explains a zero charge through the adjustment the server recorded', async () => {
  const dialog = await openDialog(
    makeLog(
      {
        model_ratio: 1.5,
        completion_ratio: 3,
        group_ratio: 1.2,
        charge_adjustment: { kind: 'no_billable_usage' },
      },
      0
    )
  )

  expect(
    dialog.getByText('No billable usage was recorded for this request.')
  ).toBeVisible()
  expect(
    dialog.getByText(
      'This request carried no billable usage, so nothing was charged.'
    )
  ).toBeVisible()
  // Nothing was charged and nothing was computed, so the two still agree.
  expect(dialog.queryByText('Difference')).toBeNull()
})

test('names the billing mode and prices a per-call request as one call', async () => {
  const dialog = await openDialog(
    makeLog({ model_price: 0.25, group_ratio: 1 }, 125000)
  )

  // Once as the mode of the charge, once as the term it was built from.
  expect(dialog.getAllByText('Per-call')).toHaveLength(2)
  expect(dialog.getByText('1 calls × $0.25')).toBeVisible()
  expect(
    dialog.getByText('Computed total').nextElementSibling
  ).toHaveTextContent('$0.25')
})

test('reports a per-image charge as one the record cannot itemize', async () => {
  const dialog = await openDialog(
    makeLog(
      {
        image: true,
        image_count: 4,
        model_price: 0.03,
        model_ratio: 1.5,
        group_ratio: 1.2,
      },
      60000
    )
  )

  expect(dialog.getByText(/This request was billed per image/)).toBeVisible()
  // The conclusion still states what was charged, even without terms.
  expect(dialog.getAllByText('Charged').length).toBeGreaterThan(0)
})

test('points an expression-priced request at the tier breakdown', async () => {
  const dialog = await openDialog(
    makeLog(
      {
        billing_mode: 'tiered_expr',
        expr_b64: btoa('tier("music", u("clips") * 0.25)'),
        matched_tier: 'music',
        model_ratio: 1.5,
      },
      5000
    )
  )

  expect(
    dialog.getByText(/This request was priced by a billing expression/)
  ).toBeVisible()
  // The mode of the charge, and the breakdown the note points at.
  expect(dialog.getAllByText('Dynamic Pricing')).toHaveLength(2)
})

test('says so when a record carries no pricing fields to explain the charge', async () => {
  const dialog = await openDialog(makeLog({}, 0))

  expect(
    dialog.getByText(/This record does not carry the pricing fields/)
  ).toBeVisible()
  // The charge itself is still stated for a record that cannot be broken down.
  expect(dialog.getAllByText('Charged').length).toBeGreaterThan(0)
})

test.each([true, false])(
  'plugin information in the dialog respects admin=%s',
  async (isAdmin) => {
    const dialog = await openDialog(
      makeLog(
        { model_price: 0.25, admin_info: { task_plugin: plugin } },
        125000
      ),
      isAdmin
    )
    expandTechnicalDetails()

    if (isAdmin) {
      expect(dialog.getByText('Incho')).toBeVisible()
      expect(dialog.getByText('1.0.1')).toBeVisible()
      expect(dialog.getByText('Plugin maintainer')).toBeVisible()
    } else {
      expect(dialog.queryByText('Incho')).toBeNull()
      expect(dialog.queryByText('Plugin maintainer')).toBeNull()
    }
  }
)

test('states the charge above the fold for a request whose content is empty', async () => {
  // A consume log with no token counts has no token or content section, so the
  // panel must not claim sections it does not hold.
  const dialog = await openDialog(
    makeLog({ model_ratio: 1.5, completion_ratio: 3, group_ratio: 1.2 }, 4500)
  )

  expect(
    dialog.getByRole('button', { name: 'Technical details, 2 sections' })
  ).toBeVisible()
  expect(dialog.getByText('Computed total')).toBeVisible()
})
