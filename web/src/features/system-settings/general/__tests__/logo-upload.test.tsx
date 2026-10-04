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
import { toast } from 'sonner'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { SystemInfoSection } from '../system-info-section'

const logoURL = 'https://example.com/logo.png'
function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <SystemInfoSection
          defaultValues={{
            SystemName: 'New API',
            ServerAddress: '',
            TaskPublicAddress: '',
            Logo: logoURL,
            general_setting: { docs_link: '' },
            legal: {},
          }}
        />
      </SettingsPageProvider>
    </>
  )
}
async function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData(['status'], { logo: logoURL })
  const router = createRouter({
    routeTree: createRootRoute({ component: Fixture }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByLabelText('Upload image')
  return { client, view }
}
beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('choosing a logo previews it and saves it only on confirmation, refreshing public status', async () => {
  const user = userEvent.setup()
  const { client, view } = await renderSection()
  await user.upload(
    screen.getByLabelText('Upload image'),
    new File(['png fixture'], 'logo.png', { type: 'image/png' })
  )
  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute(
      'src',
      'data:image/png;base64,cG5nIGZpeHR1cmU='
    )
  )
  expect(api.put).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Logo URL')).toHaveValue('')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'Logo',
      value: 'data:image/png;base64,cG5nIGZpeHR1cmU=',
    })
  )
  expect(client.getQueryState(['status'])?.isInvalidated).toBe(true)
  view.unmount()
  client.clear()
})

test('oversized or unsupported logo files preserve the current logo', async () => {
  const error = vi.spyOn(toast, 'error')
  const user = userEvent.setup({ applyAccept: false })
  const { client, view } = await renderSection()
  for (const file of [
    new File([new Uint8Array(256 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    }),
    new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
  ]) {
    await user.upload(screen.getByLabelText('Upload image'), file)
    expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute(
      'src',
      logoURL
    )
  }
  expect(error).toHaveBeenCalledTimes(2)
  expect(api.put).not.toHaveBeenCalled()
  view.unmount()
  client.clear()
})

test('a logo can be removed and reset without changing the saved configuration', async () => {
  const user = userEvent.setup()
  const { client, view } = await renderSection()
  await user.click(screen.getByRole('button', { name: 'Remove image' }))
  expect(screen.queryByRole('img', { name: 'Logo' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute(
    'src',
    logoURL
  )
  expect(api.put).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText('Logo URL'))
  await user.type(
    screen.getByLabelText('Logo URL'),
    'https://example.com/new.png'
  )
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'Logo',
      value: 'https://example.com/new.png',
    })
  )
  view.unmount()
  client.clear()
})

test('a file read failure keeps the current logo and allows saving again', async () => {
  const error = vi.spyOn(toast, 'error')
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(
    function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('error'))
      this.dispatchEvent(new ProgressEvent('loadend'))
    }
  )
  const user = userEvent.setup()
  const { client, view } = await renderSection()
  await user.upload(
    screen.getByLabelText('Upload image'),
    new File(['png'], 'logo.png', { type: 'image/png' })
  )
  expect(error).toHaveBeenCalledWith('Failed to read image')
  expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute(
    'src',
    logoURL
  )
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
  expect(api.put).not.toHaveBeenCalled()
  view.unmount()
  client.clear()
})
