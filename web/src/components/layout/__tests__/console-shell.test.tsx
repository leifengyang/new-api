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
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DirectionProvider } from '@/context/direction-provider'
import { ThemeCustomizationProvider } from '@/context/theme-customization-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { AuthenticatedLayout } from '../components/authenticated-layout'
import { SectionPageLayout } from '../components/section-page-layout'

let client: QueryClient

beforeEach(async () => {
  await i18next.changeLanguage('en')
  localStorage.clear()
  for (const name of [
    'sidebar_state',
    'layout_variant',
    'layout_collapsible',
  ]) {
    document.cookie = `${name}=; max-age=0; path=/`
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['notice'], { success: true, data: '' })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: {} } })
  client.setQueryData(['status'], {
    system_name: 'New API',
    version: 'v1.0.0-test',
  })
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'alice', display_name: 'Alice', role: 1 })
})

afterEach(async () => {
  await i18next.changeLanguage('en')
  cleanup()
  client.clear()
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  i18next.removeResourceBundle('zh', 'translation')
})

async function renderConsole(path = '/keys') {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ThemeCustomizationProvider>
            <DirectionProvider>
              <AuthenticatedLayout>
                <SectionPageLayout fixedContent>
                  <SectionPageLayout.Title>
                    Page content
                  </SectionPageLayout.Title>
                  <SectionPageLayout.Content>
                    <div>Table content</div>
                  </SectionPageLayout.Content>
                </SectionPageLayout>
              </AuthenticatedLayout>
            </DirectionProvider>
          </ThemeCustomizationProvider>
        </ThemeProvider>
      </QueryClientProvider>
    ),
    notFoundComponent: () => null,
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await act(async () => {
    await router.load()
  })
  const result = render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { name: 'Page content' })
  return { ...result, router }
}

describe('console navigation shell', () => {
  it('shows the brand and account in the sidebar, with the active page in the header', async () => {
    const { container } = await renderConsole()
    const sidebar = container.querySelector(
      '[data-slot="sidebar-inner"]'
    ) as HTMLElement
    expect(
      within(sidebar).getByRole('link', { name: 'Go to home' })
    ).toHaveAttribute('href', '/')
    expect(within(sidebar).getByText('New API')).toBeVisible()
    expect(within(sidebar).getByRole('button', { name: 'Alice' })).toBeVisible()
    expect(
      within(screen.getByRole('navigation', { name: 'breadcrumb' })).getByText(
        'API Keys'
      )
    ).toHaveAttribute('aria-current', 'page')
    expect(
      within(sidebar).queryByRole('link', { name: 'Channels' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Table content').parentElement).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-hidden'
    )
  })

  it('collapses to icons through the header and expands again through the keyboard shortcut', async () => {
    const user = userEvent.setup()
    const { container } = await renderConsole()
    await user.click(
      within(container.querySelector('header') as HTMLElement).getByRole(
        'button',
        {
          name: 'Toggle Sidebar',
        }
      )
    )
    expect(container.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      'data-collapsible',
      'icon'
    )
    expect(document.cookie).toContain('sidebar_state=false')
    await user.keyboard('{Control>}b{/Control}')
    expect(container.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      'data-state',
      'expanded'
    )
  })

  it('opens the shared account menu with the keyboard and keeps sign out behind confirmation', async () => {
    const user = userEvent.setup()
    const post = vi.spyOn(api, 'post')
    await renderConsole()
    screen.getByRole('button', { name: 'Alice' }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByRole('button', { name: 'Sign out' })
    ).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    )
    expect(post).not.toHaveBeenCalled()
  })

  it('closes the mobile navigation after selecting a destination', async () => {
    vi.stubGlobal('innerWidth', 390)
    document.cookie = 'sidebar_state=false; path=/'
    const user = userEvent.setup()
    const { container } = await renderConsole()
    const toggle = within(
      container.querySelector('header') as HTMLElement
    ).getByRole('button', { name: 'Toggle Sidebar' })
    await user.click(toggle)
    const drawer = await screen.findByRole('dialog')
    await user.click(within(drawer).getByRole('link', { name: 'API Keys' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(toggle).toBeVisible()
  })

  it('closes the mobile drawer when opening the profile from its account menu', async () => {
    vi.stubGlobal('innerWidth', 390)
    const user = userEvent.setup()
    const { container, router } = await renderConsole()
    await user.click(
      within(container.querySelector('header') as HTMLElement).getByRole(
        'button',
        {
          name: 'Toggle Sidebar',
        }
      )
    )
    const drawer = await screen.findByRole('dialog')
    await user.click(within(drawer).getByRole('button', { name: 'Alice' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Profile' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(router.state.location.pathname).toBe('/profile')
  })

  it('updates breadcrumb labels when the interface language changes', async () => {
    await renderConsole()
    i18next.addResourceBundle('zh', 'translation', {
      'API Keys': 'API \u5bc6\u94a5',
      General: '\u5e38\u89c4',
      Dashboard: '\u6570\u636e\u770b\u677f',
    })
    await act(async () => {
      await i18next.changeLanguage('zh')
    })
    expect(
      within(screen.getByRole('navigation', { name: 'breadcrumb' })).getByText(
        'API \u5bc6\u94a5'
      )
    ).toHaveAttribute('aria-current', 'page')
  })

  it('uses contextual settings navigation for nested pages', async () => {
    useAuthStore
      .getState()
      .auth.setUser({ id: 1, username: 'alice', role: 100 })
    await renderConsole('/system-settings/site/system-info')
    expect(
      screen.getByRole('link', { name: 'Back to Dashboard' })
    ).toBeVisible()
    expect(
      within(screen.getByRole('navigation', { name: 'breadcrumb' })).getByText(
        'System Information'
      )
    ).toHaveAttribute('aria-current', 'page')
  })
})
