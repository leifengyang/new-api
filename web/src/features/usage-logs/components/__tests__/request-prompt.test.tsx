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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  RequestPromptButton,
  RequestPromptCaptureSwitch,
} from '../request-prompt'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))
const clients: QueryClient[] = []

function renderPrompt(
  isRoot = true,
  requestId: string | undefined = 'request-1'
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <RequestPromptButton requestId={requestId} isRoot={isRoot} />
    </QueryClientProvider>
  )
  return client
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
  vi.mocked(api.get).mockReset()
  vi.mocked(api.put).mockReset()
})

it('does not expose the button or fetch content for non-root users', () => {
  renderPrompt(false)
  expect(
    screen.queryByRole('button', { name: 'View user prompt' })
  ).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalled()
})

it('loads only when opened, safely displays text, copies the saved text and clears the query on close', async () => {
  const text = '<script>unsafe()</script>\nUser question'
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  vi.mocked(api.get).mockResolvedValue({
    data: {
      success: true,
      data: {
        status: 'captured',
        text,
        truncated: true,
        attachments: 'image,audio',
      },
    },
  })
  const client = renderPrompt()
  expect(api.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'View user prompt' }))
  expect(await screen.findByText('Contains image')).toBeVisible()
  expect(screen.getByText('Contains audio')).toBeVisible()
  expect(
    screen.getByText('Truncated: beginning and end retained (128 KB limit)')
  ).toBeVisible()
  const pre = screen.getByText(/unsafe\(\)/)
  expect(pre.textContent).toBe(text)
  expect(pre.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text))
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() =>
    expect(client.getQueryData(['request-prompt', 'request-1'])).toBeUndefined()
  )
})

it.each([
  [
    'unavailable',
    'No saved prompt. It may predate capture, have expired after 7 days, or could not be stored.',
  ],
  ['disabled', 'Prompt capture was disabled for this request.'],
  ['invalid_body', 'No readable user message was found in this request.'],
])('explains why content is absent for %s', async (status, message) => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { status } },
  })
  renderPrompt()
  fireEvent.click(screen.getByRole('button', { name: 'View user prompt' }))
  expect(await screen.findByText(message)).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Copy to clipboard' })
  ).not.toBeInTheDocument()
})

it('allows retry after a detail request fails', async () => {
  vi.mocked(api.get)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      data: { success: true, data: { status: 'captured', text: 'recovered' } },
    })
  renderPrompt()
  fireEvent.click(screen.getByRole('button', { name: 'View user prompt' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('recovered')).toBeVisible()
})

it('keeps the capture setting unchanged while saving and after failure, then applies a successful change', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { enabled: true } },
  })
  vi.mocked(api.put)
    .mockResolvedValueOnce({ data: { success: false, message: 'save failed' } })
    .mockResolvedValueOnce({
      data: { success: true, data: { enabled: false } },
    })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <RequestPromptCaptureSwitch />
    </QueryClientProvider>
  )
  const toggle = screen.getByRole('switch', {
    name: 'Capture user prompts (7 days)',
  })
  await waitFor(() => expect(toggle).toBeChecked())
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeDisabled())
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(api.put).toHaveBeenLastCalledWith('/api/log/prompt-capture', {
    enabled: false,
  })
})
