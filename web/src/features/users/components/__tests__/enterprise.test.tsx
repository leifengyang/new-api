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

// 空的语言包，t('...') 一律返回 key 本身，断言就不随语言变。
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})

function makeUser(
  id: number,
  username: string,
  extra: Partial<User> = {}
): User {
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
    member_level: 0,
    ...extra,
  }
}

const plainUser = makeUser(3, 'plain-user')
const anotherPlainUser = makeUser(4, 'another-plain-user')
const enterpriseUser = makeUser(5, 'enterprise-user', { is_enterprise: 1 })
const adminUser = makeUser(6, 'admin-user', { role: 10 })
const memberUser = makeUser(7, 'member-user', { enterprise_owner_id: 5 })

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

function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return client
}

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
  await router.load()
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={newClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>
  )
  await screen.findByText(users[0].username)
  return get
}

// 用固定数据渲染真实列，好在首屏之前就把选中状态摆好——服务端列表做不到。
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

// 行操作菜单一挂载就会渲染弹窗，所以这里也要给它同样的 provider。
function renderSelectedRows(users: User[], selectedIndexes: number[]) {
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={newClient()}>
        <SelectedRowsHarness users={users} selectedIndexes={selectedIndexes} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

async function confirmDialog() {
  return screen.findByRole('alertdialog')
}

it('filters the server search by enterprise account', async () => {
  const get = await renderUsersList([enterpriseUser, plainUser])
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Enterprise' }))
  await user.click(
    await screen.findByRole('option', { name: 'Enterprise Account' })
  )

  await waitFor(() => {
    const searchUrl = get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/api/user/search'))
    expect(searchUrl).toBeDefined()
    expect(searchUrl).toContain('is_enterprise=1')
  })
})

it('marks every selected account with one request each', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({
      data: { success: true, data: { released_members: 0 } },
    })
  const user = userEvent.setup()
  renderSelectedRows([plainUser, anotherPlainUser], [0, 1])

  await user.click(
    screen.getByRole('button', { name: 'Mark as enterprise account' })
  )
  const dialog = await confirmDialog()
  expect(
    within(dialog).getByText('Mark 2 users as enterprise accounts?')
  ).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

  await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
  expect(put).toHaveBeenCalledWith('/api/user/enterprise', {
    id: plainUser.id,
    is_enterprise: true,
  })
  expect(put).toHaveBeenCalledWith('/api/user/enterprise', {
    id: anotherPlainUser.id,
    is_enterprise: true,
  })
})

it('leaves accounts that are already enterprise accounts out of the request', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({
      data: { success: true, data: { released_members: 0 } },
    })
  const user = userEvent.setup()
  renderSelectedRows([enterpriseUser, plainUser], [0, 1])

  await user.click(
    screen.getByRole('button', { name: 'Mark as enterprise account' })
  )
  const dialog = await confirmDialog()
  expect(
    within(dialog).getByText('Mark 1 users as enterprise accounts?')
  ).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  expect(put).toHaveBeenCalledWith('/api/user/enterprise', {
    id: plainUser.id,
    is_enterprise: true,
  })
})

it('refuses a selection holding an administrator or an enterprise member', async () => {
  const put = vi.spyOn(api, 'put')
  const user = userEvent.setup()
  renderSelectedRows([plainUser, adminUser, memberUser], [0, 1, 2])

  const button = screen.getByRole('button', {
    name: 'Mark as enterprise account',
  })
  expect(button).toHaveAttribute('aria-disabled', 'true')

  await user.click(button)

  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(put).not.toHaveBeenCalled()
})

it('refuses a selection that is already all enterprise accounts', async () => {
  renderSelectedRows([enterpriseUser], [0])

  expect(
    screen.getByRole('button', { name: 'Mark as enterprise account' })
  ).toHaveAttribute('aria-disabled', 'true')
})
