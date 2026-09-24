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
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
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
import { UsersTable } from '../users-table'

// The locale bundle is intentionally empty, so every t('...') resolves to its
// own English key and the queries below stay stable across languages.
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

const EXTERNAL = 0
const INTERNAL = 1

function makeUser(id: number, username: string, memberLevel: number): User {
  return {
    id,
    username,
    display_name: `${username} display`,
    role: 1,
    status: 1,
    quota: 0,
    used_quota: 0,
    request_count: 0,
    group: 'default',
    member_level: memberLevel,
  }
}

const internalStudent = makeUser(2, 'internal-student', INTERNAL)
const externalUser = makeUser(3, 'external-user', EXTERNAL)

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

function UsersPage() {
  return (
    <TooltipProvider>
      <UsersProvider>
        <UsersTable />
      </UsersProvider>
    </TooltipProvider>
  )
}

async function renderUsersList(users: User[]) {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'admin', role: 100 })
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: users, total: users.length, page: 1, page_size: 20 },
    },
  })
  const root = createRootRoute()
  const auth = createRoute({ getParentRoute: () => root, id: '_authenticated' })
  const usersRoute = createRoute({
    getParentRoute: () => auth,
    path: 'users/',
    component: UsersPage,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([usersRoute])]),
    history: createMemoryHistory({ initialEntries: ['/users/'] }),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  await router.load()
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>
  )
  await screen.findByText(users[0].username)
  return get
}

// Renders the real columns against a fixed data set so row selection can be
// placed before the first paint, which the server-backed list cannot do.
function SelectedRowsHarness(props: {
  users: User[]
  selectedIndexes: number[]
}) {
  const columns = useUsersColumns()
  const table = useReactTable({
    columns,
    data: props.users,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    initialState: {
      rowSelection: Object.fromEntries(
        props.selectedIndexes.map((index) => [String(index), true])
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

function renderSelectedRows(users: User[], selectedIndexes: number[]) {
  // The row action menu renders dialogs that query on mount, so the harness
  // needs the same providers the real page supplies.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SelectedRowsHarness users={users} selectedIndexes={selectedIndexes} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

async function confirmDialog() {
  const dialog = await screen.findByRole('alertdialog')
  return dialog
}

it('labels each row with its member level and filters the server search', async () => {
  const get = await renderUsersList([internalStudent, externalUser])
  const user = userEvent.setup()

  const rows = screen.getAllByRole('row').slice(1)
  expect(within(rows[0]).getByText('Internal Member')).toBeInTheDocument()
  expect(within(rows[1]).getByText('External')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Member Level' }))
  await user.click(
    await screen.findByRole('option', { name: 'Internal Member' })
  )

  await waitFor(() => {
    const searchUrl = get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/api/user/search'))
    expect(searchUrl).toBeDefined()
    expect(searchUrl).toContain('member_level=1')
  })
})

it('bulk marks every selected user as an internal member', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: 2 } })
  const user = userEvent.setup()
  renderSelectedRows(
    [externalUser, makeUser(4, 'another-external', EXTERNAL)],
    [0, 1]
  )

  await user.click(
    screen.getByRole('button', { name: 'Mark as internal member' })
  )
  const dialog = await confirmDialog()
  expect(
    within(dialog).getByText('Mark 2 users as internal members?')
  ).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/member_level/batch', {
      ids: [3, 4],
      member_level: INTERNAL,
    })
  )
})

it('disables a bulk action that would not change the selected rows', async () => {
  renderSelectedRows([internalStudent], [0])

  expect(
    screen.getByRole('button', { name: 'Mark as internal member' })
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Mark as external user' })
  ).toBeEnabled()
})

it('row menu marks a single user as an external user', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderSelectedRows([internalStudent], [])

  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  await user.click(
    await screen.findByRole('menuitem', { name: 'Mark as external user' })
  )
  const dialog = await confirmDialog()
  expect(
    within(dialog).getByText('Mark internal-student as an external user?')
  ).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/api/user/member_level', {
      id: internalStudent.id,
      member_level: EXTERNAL,
    })
  )
})
