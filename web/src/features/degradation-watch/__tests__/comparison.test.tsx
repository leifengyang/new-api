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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { SelfTestPanel } from '../components/self-test-panel'
import {
  comparisonRequest,
  latestComparisonAttempts,
  type ComparisonAttempt,
} from '../lib/comparison'
import { migrateSelfTestSettings } from '../lib/storage'

vi.mock('../lib/comparison', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/comparison')>()),
  comparisonRequest: vi.fn(),
}))
vi.mock('../hooks/use-degradation-watch', () => ({
  useDegradationWatchPrompt: () => ({
    data: { prompt: 'Draw an SVG bird', targets: [{ model: 'test-model' }] },
  }),
  useInViewport: () => ({ ref: { current: null }, inView: false }),
  useRecordHtml: () => ({}),
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SelfTestPanel />
    </QueryClientProvider>
  )
}

test('submits independent groups with shared prompt, concurrency three and twenty minute timeout', async () => {
  vi.mocked(comparisonRequest).mockImplementation(async (path, method) => {
    if (method === 'post') return { id: 12 }
    if (path === '/rounds/12') {
      return {
        round: { id: 12, status: 'completed', prompt: 'Draw an SVG bird' },
        attempts: [],
      }
    }
    return []
  })
  renderPanel()
  await screen.findByLabelText('Group name')
  await waitFor(() =>
    expect(screen.getByLabelText('Shared prompt')).toHaveValue(
      'Draw an SVG bird'
    )
  )
  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'https://a.example/v1' },
  })
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: 'key-one' },
  })
  fireEvent.click(screen.getByText('Add test group'))
  fireEvent.change(screen.getAllByLabelText('Base URL')[1], {
    target: { value: 'https://b.example/v1' },
  })
  fireEvent.change(screen.getAllByLabelText('API key')[1], {
    target: { value: 'key-two' },
  })
  fireEvent.change(screen.getAllByLabelText('Model')[1], {
    target: { value: 'second-model' },
  })
  fireEvent.change(screen.getAllByLabelText('Protocol')[1], {
    target: { value: 'responses' },
  })
  fireEvent.click(screen.getByText('Start comparison'))
  await waitFor(() =>
    expect(comparisonRequest).toHaveBeenCalledWith(
      '/rounds',
      'post',
      expect.objectContaining({
        concurrency: 3,
        timeout_seconds: 1200,
        prompt: 'Draw an SVG bird',
        groups: [
          expect.objectContaining({
            base_url: 'https://a.example/v1',
            api_key: 'key-one',
            model: 'test-model',
            remember_key: false,
          }),
          expect.objectContaining({
            base_url: 'https://b.example/v1',
            api_key: 'key-two',
            model: 'second-model',
            protocol: 'responses',
          }),
        ],
      })
    )
  )
  expect(
    localStorage.getItem('degradation-watch:self-test-settings') ?? ''
  ).not.toContain('key-one')
})

test('restores a running round after remount without starting another request', async () => {
  const attempt = {
    id: 1,
    round_id: 12,
    group_index: 0,
    attempt: 1,
    name: 'Background group',
    model: 'test-model',
    protocol: 'chat',
    base_url: 'https://a.example/v1',
    status: 'running',
    input_tokens: 25,
    output_tokens: 6,
    reasoning_tokens: 2,
    elapsed_ms: 2000,
    first_token_ms: 100,
    created_at: 1000,
    error: '',
  }
  vi.mocked(comparisonRequest).mockImplementation(async (path) => {
    if (path === '/rounds') {
      return [{ id: 12, status: 'running', created_at: 1000 }]
    }
    if (path === '/rounds/12') {
      return {
        round: { id: 12, status: 'running', prompt: 'Snapshot' },
        attempts: [attempt],
      }
    }
    return []
  })
  const first = renderPanel()
  expect(await screen.findByText('Background group')).toBeInTheDocument()
  expect(screen.getByText('Start comparison')).toBeDisabled()
  first.unmount()
  renderPanel()
  expect(await screen.findByText('Background group')).toBeInTheDocument()
  expect(
    vi
      .mocked(comparisonRequest)
      .mock.calls.every(([, method]) => method !== 'post')
  ).toBe(true)
})

test('retries select the latest attempt without discarding earlier attempts', () => {
  const attempts = [
    { id: 1, group_index: 0, attempt: 1 },
    { id: 2, group_index: 1, attempt: 1 },
    { id: 3, group_index: 0, attempt: 2 },
  ] as ComparisonAttempt[]
  expect(latestComparisonAttempts(attempts).map((item) => item.id)).toEqual([
    3, 2,
  ])
  expect(attempts).toHaveLength(3)
})

test('legacy migration removes plaintext keys while preserving history and non-secret configuration', () => {
  localStorage.setItem(
    'degradation-watch:self-test-settings',
    JSON.stringify({
      baseUrl: 'https://example.com',
      model: 'legacy',
      apiKey: 'old-secret',
      rememberKey: true,
    })
  )
  localStorage.setItem(
    'degradation-watch:self-test-history',
    '[{"id":"legacy"}]'
  )
  expect(migrateSelfTestSettings()).toMatchObject({
    baseUrl: 'https://example.com',
    model: 'legacy',
    apiKey: '',
    rememberKey: false,
  })
  expect(
    localStorage.getItem('degradation-watch:self-test-settings')
  ).not.toContain('old-secret')
  expect(localStorage.getItem('degradation-watch:self-test-history')).toBe(
    '[{"id":"legacy"}]'
  )
})
