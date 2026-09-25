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

// Deleting accounts is gated by the shared step-up verification: the operator
// confirms the selection, passes an identity check, and only the returned proof
// authorizes the batch request. Both endpoints are mocked so every test below
// drives that real flow through the shared verification dialog.
function mockDeletionEndpoints(options?: {
  verifyResult?: { success: boolean; message?: string; code?: string }
  deleteResult?: { success: boolean; message?: string; data?: number }
}) {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/verify/methods') {
      return {
        data: {
          success: true,
          data: {
            scope: 'user.delete_batch',
            methods: [{ method: 'password', available: true }],
            oauth_providers: [],
            password_encryption_enabled: false,
          },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  let proofCount = 0
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/api/verify') {
      if (options?.verifyResult) return { data: options.verifyResult }
      proofCount += 1
      return {
        data: {
          success: true,
          data: {
            proof_token: `batch-delete-proof-${proofCount}`,
            scope: 'user.delete_batch',
            method: 'password',
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
        },
      }
    }
    if (url === '/api/user/batch') {
      return { data: options?.deleteResult ?? { success: true, data: 2 } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  return {
    get,
    post,
    batchCalls: () =>
      post.mock.calls.filter(([url]) => url === '/api/user/batch'),
  }
}

async function passIdentityCheck(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText('Password', { selector: 'input' }),
    'operator-password'
  )
  await user.click(screen.getByRole('button', { name: 'Verify' }))
}

function confirmDialog() {
  return screen.findByRole('alertdialog', { name: 'Delete 2 users?' })
}

it('deletes the selection only after the identity check passes', async () => {
  const { post, batchCalls } = mockDeletionEndpoints()
  const user = userEvent.setup()
  renderSelectedRows(
    [commonUser, secondCommonUser],
    [commonUser.id, secondCommonUser.id]
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete selected users' })
  )
  const dialog = await confirmDialog()
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

  // The confirmation alone authorizes nothing, and the check is bound to the
  // exact ids the operator selected.
  expect(batchCalls()).toHaveLength(0)
  expect(
    await screen.findByRole('dialog', { name: 'Verify to delete 2 users' })
  ).toBeInTheDocument()
  await passIdentityCheck(user)
  expect(post).toHaveBeenCalledWith(
    '/api/verify',
    expect.objectContaining({
      method: 'password',
      scope: 'user.delete_batch',
      context: { user_ids: [commonUser.id, secondCommonUser.id] },
    }),
    expect.anything()
  )

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/user/batch',
      { ids: [commonUser.id, secondCommonUser.id] },
      expect.objectContaining({
        headers: { 'X-Security-Proof': 'batch-delete-proof-1' },
      })
    )
  )
  // The deleted rows leave the selection, which empties the bulk toolbar.
  await waitFor(() =>
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  )
})

it('deletes nothing when the identity check fails or is cancelled', async () => {
  const { batchCalls } = mockDeletionEndpoints({
    verifyResult: { success: false, message: 'Wrong password' },
  })
  const user = userEvent.setup()
  renderSelectedRows(
    [commonUser, secondCommonUser],
    [commonUser.id, secondCommonUser.id]
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete selected users' })
  )
  const dialog = await confirmDialog()
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
  await passIdentityCheck(user)

  // A rejected verification keeps the prompt open and never reaches the delete
  // endpoint, even though the operator had already confirmed the selection.
  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password')
  expect(batchCalls()).toHaveLength(0)
  await user.click(
    within(
      screen.getByRole('dialog', { name: 'Verify to delete 2 users' })
    ).getByRole('button', { name: 'Cancel' })
  )

  // Cancelling drops the prompt without deleting, and the confirmation comes
  // back on the same selection.
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Verify to delete 2 users' })
    ).not.toBeInTheDocument()
  )
  expect(batchCalls()).toHaveLength(0)
  expect(await confirmDialog()).toBeInTheDocument()
  expect(screen.getByLabelText('2 selected')).toBeInTheDocument()
})

it('keeps the selection and offers a retry when the server refuses', async () => {
  const { batchCalls } = mockDeletionEndpoints({
    deleteResult: { success: false, message: 'refused' },
  })
  const user = userEvent.setup()
  renderSelectedRows(
    [commonUser, secondCommonUser],
    [commonUser.id, secondCommonUser.id]
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete selected users' })
  )
  const dialog = await confirmDialog()
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
  await passIdentityCheck(user)

  // A refusal keeps the dialog open on the same selection so the operator can
  // simply confirm again; nothing was deleted, so nothing may be dropped. The
  // proof was already spent, so the second attempt asks for a fresh one.
  await waitFor(() => expect(batchCalls()).toHaveLength(1))
  await user.click(
    within(await confirmDialog()).getByRole('button', { name: 'Delete' })
  )
  await passIdentityCheck(user)
  await waitFor(() => expect(batchCalls()).toHaveLength(2))

  await user.click(
    within(await confirmDialog()).getByRole('button', { name: 'Cancel' })
  )
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
