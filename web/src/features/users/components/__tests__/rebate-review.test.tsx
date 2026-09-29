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
  fireEvent,
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

function makeUser(
  id: number,
  username: string,
  memberLevel: number,
  rebateReviewStatus?: string
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
    member_level: memberLevel,
    ...(rebateReviewStatus ? { rebate_review_status: rebateReviewStatus } : {}),
  }
}

const pendingInternal = makeUser(2, 'pending-internal', INTERNAL, 'pending')
const approvedInternal = makeUser(3, 'approved-internal', INTERNAL, 'approved')
const rejectedInternal = makeUser(4, 'rejected-internal', INTERNAL, 'rejected')
const externalUser = makeUser(5, 'external-user', EXTERNAL)

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
  return screen.findByRole('alertdialog')
}

it('labels each internal member with its review status and leaves outsiders blank', async () => {
  renderSelectedRows(
    [pendingInternal, approvedInternal, rejectedInternal, externalUser],
    []
  )

  const rows = screen.getAllByRole('row').slice(1)
  expect(within(rows[0]).getByText('Pending Review')).toBeInTheDocument()
  expect(within(rows[1]).getByText('Approved')).toBeInTheDocument()
  expect(within(rows[2]).getByText('Not Approved')).toBeInTheDocument()
  // 外部账号不参与返现，这一列对它没有意义，留空而不是显示「未审核」。
  expect(within(rows[3]).queryByText('Pending Review')).toBeNull()
})

it('treats a missing review status as pending', async () => {
  // 审核状态这一列是随功能一起加的，老数据可能还没有这个字段。
  const legacyInternal = makeUser(6, 'legacy-internal', INTERNAL)
  renderSelectedRows([legacyInternal], [])

  const rows = screen.getAllByRole('row').slice(1)
  expect(within(rows[0]).getByText('Pending Review')).toBeInTheDocument()
})

it('filters the server search by review status', async () => {
  const get = await renderUsersList([pendingInternal, approvedInternal])
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Rebate Review' }))
  await user.click(
    await screen.findByRole('option', { name: 'Pending Review' })
  )

  await waitFor(() => {
    const searchUrl = get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/api/user/search'))
    expect(searchUrl).toBeDefined()
    expect(searchUrl).toContain('rebate_review_status=pending')
  })
})

it('row menu approves a single internal member and reports the released rows', async () => {
  const put = vi
    .spyOn(api, 'put')
    // 服务端返回的是这次真正放行的返现行数。
    .mockResolvedValue({ data: { success: true, data: 3 } })
  const user = userEvent.setup()
  renderSelectedRows([pendingInternal], [])

  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  await user.hover(await screen.findByRole('menuitem', { name: 'Review' }))
  // 子菜单弹出时 Base UI 的定位层还是 inert（pointer-events: none），user-event 的
  // 指针检查会直接抛错，所以这里直接派发点击——菜单项本来也是靠 onClick 选中的。
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve' }))
  const dialog = await confirmDialog()
  expect(
    within(dialog).getByText('Approve the rebate review for pending-internal?')
  ).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/api/user/rebate_review', {
      id: pendingInternal.id,
      rebate_review_status: 'approved',
    })
  )
})

it('offers the review submenu only to internal members', async () => {
  const user = userEvent.setup()
  renderSelectedRows([externalUser], [])

  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  // 外部账号没有返现可审，菜单里不该出现这一项。
  expect(
    await screen.findByRole('menuitem', { name: 'Mark as internal member' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Review' })).toBeNull()
})

it('marks the current review status as already applied', async () => {
  const user = userEvent.setup()
  renderSelectedRows([approvedInternal], [])

  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  await user.hover(await screen.findByRole('menuitem', { name: 'Review' }))

  // 当前状态那一项留着但点不动，而不是藏起来——它同时说明「现在是哪一个」。
  // Base UI 的禁用是 aria-disabled，不是原生 disabled 属性。
  expect(
    (await screen.findByRole('menuitem', { name: 'Approve' })).getAttribute(
      'aria-disabled'
    )
  ).toBe('true')
  expect(
    screen.getByRole('menuitem', { name: 'Not Approved' })
  ).not.toHaveAttribute('aria-disabled', 'true')
})

it('bulk approves every selected internal member that has not passed yet', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: 5 } })
  const user = userEvent.setup()
  // 已通过的会被剔除，服务端那边只会白写一条审计日志。
  renderSelectedRows(
    [pendingInternal, approvedInternal, rejectedInternal],
    [0, 1, 2]
  )

  await user.click(
    screen.getByRole('button', { name: 'Approve rebate review' })
  )
  const dialog = await confirmDialog()
  expect(
    within(dialog).getByText('Approve the rebate review for 2 users?')
  ).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/rebate_review/batch', {
      ids: [pendingInternal.id, rejectedInternal.id],
      rebate_review_status: 'approved',
    })
  )
})

it('disables the bulk action when nothing is left to approve', async () => {
  renderSelectedRows([approvedInternal, externalUser], [0, 1])

  // 两个选中项都做不成事：一个已经通过，一个根本不是内部会员。
  expect(
    screen.getByRole('button', { name: 'Approve rebate review' })
  ).toHaveAttribute('aria-disabled', 'true')
})
