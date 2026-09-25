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
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import type { User } from '../../types'
import { DataTableBulkActions } from '../data-table-bulk-actions'
import { useUsersColumns } from '../users-columns'
import { UsersProvider } from '../users-provider'

// The locale bundle is intentionally empty, so every t('...') resolves to its
// own English key and the queries below stay stable across languages.
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

const COMMON = 1
const ADMIN = 10
const ROOT = 100

function makeUser(id: number, username: string, role: number): User {
  return {
    id,
    username,
    display_name: `${username} display`,
    role,
    status: 1,
    quota: 0,
    used_quota: 0,
    request_count: 0,
    group: 'default',
  }
}

const commonUser = makeUser(3, 'plain-user', COMMON)
const secondCommonUser = makeUser(4, 'other-user', COMMON)

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
  useAuthStore.getState().auth.reset()
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

// Renders the real columns against a fixed data set so row selection can be
// placed before the first paint. getRowId mirrors users-table.tsx, which is
// what makes the post-delete selection cleanup address the same keys.
function SelectedRowsHarness(props: { users: User[]; selectedIds: number[] }) {
  const columns = useUsersColumns()
  const table = useReactTable({
    columns,
    data: props.users,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    getRowId: (row) => String(row.id),
    initialState: {
      rowSelection: Object.fromEntries(
        props.selectedIds.map((id) => [String(id), true])
      ),
    },
  })
  return (
    <TooltipProvider>
      <UsersProvider>
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id}>
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
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
        <DataTableBulkActions table={table} />
      </UsersProvider>
    </TooltipProvider>
  )
}

function renderSelectedRows(
  users: User[],
  selectedIds: number[],
  operatorRole = ROOT
) {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'operator', role: operatorRole })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SelectedRowsHarness users={users} selectedIds={selectedIds} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

it('deletes every selected user after confirmation', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: 2 } })
  const user = userEvent.setup()
  renderSelectedRows(
    [commonUser, secondCommonUser],
    [commonUser.id, secondCommonUser.id]
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete selected users' })
  )
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveAccessibleName('Delete 2 users?')

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/batch', {
      ids: [commonUser.id, secondCommonUser.id],
    })
  )
  // The deleted rows leave the selection, which empties the bulk toolbar.
  await waitFor(() =>
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  )
})

it('keeps the selection and offers a retry when the server refuses', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: false, message: 'refused' } })
  const user = userEvent.setup()
  renderSelectedRows(
    [commonUser, secondCommonUser],
    [commonUser.id, secondCommonUser.id]
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete selected users' })
  )
  const dialog = await screen.findByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

  // A refusal keeps the dialog open on the same selection so the operator can
  // simply confirm again; nothing was deleted, so nothing may be dropped.
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('alertdialog')).toHaveAccessibleName(
    'Delete 2 users?'
  )
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))

  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
  expect(screen.getByLabelText('2 selected')).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Delete selected users' })
  ).toBeEnabled()
})

it('offers bulk delete only while every selected account is below the operator', async () => {
  const peerAdmin = makeUser(9, 'peer-admin', ADMIN)
  renderSelectedRows(
    [commonUser, peerAdmin],
    [commonUser.id, peerAdmin.id],
    ADMIN
  )

  expect(
    screen.getByRole('button', { name: 'Delete selected users' })
  ).toBeDisabled()
})

it('allows a root operator to delete an administrator', async () => {
  const peerAdmin = makeUser(9, 'peer-admin', ADMIN)
  renderSelectedRows([peerAdmin], [peerAdmin.id], ROOT)

  expect(
    screen.getByRole('button', { name: 'Delete selected users' })
  ).toBeEnabled()
})

it('refuses to offer deleting another root account', async () => {
  const otherRoot = makeUser(8, 'other-root', ROOT)
  renderSelectedRows([otherRoot], [otherRoot.id], ROOT)

  expect(
    screen.getByRole('button', { name: 'Delete selected users' })
  ).toBeDisabled()
})
