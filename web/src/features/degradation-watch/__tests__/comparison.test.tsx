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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { ComparisonResult } from '../components/comparison-results'
import { SelfTestPanel } from '../components/self-test-panel'
import { useInViewport } from '../hooks/use-degradation-watch'
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
  useInViewport: vi.fn(() => ({ ref: { current: null }, inView: false })),
  useRecordHtml: () => ({}),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useInViewport).mockReturnValue({
    ref: { current: null },
    inView: false,
  })
  localStorage.clear()
})

function renderResult(
  overrides: Partial<ComparisonAttempt>,
  prompt = 'Saved prompt'
) {
  const attempt: ComparisonAttempt = {
    id: 1,
    round_id: 12,
    group_index: 0,
    attempt: 1,
    profile_id: 0,
    name: 'Test group',
    base_url: 'https://example.com/v1',
    model: 'test-model',
    protocol: 'chat',
    effort: 'medium',
    status: 'succeeded',
    output: '',
    html: '',
    error: '',
    input_tokens: 12,
    output_tokens: 6,
    reasoning_tokens: 0,
    tokens_estimated: false,
    elapsed_ms: 2000,
    first_token_ms: 100,
    created_at: 1000,
    started_at: 1000,
    ...overrides,
  }
  vi.mocked(comparisonRequest).mockResolvedValue(attempt)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ComparisonResult
        prompt={prompt}
        latest={{ ...attempt, output: '', html: '' }}
        attempts={[]}
        busy={false}
        onRetry={vi.fn()}
        onStop={vi.fn()}
      />
    </QueryClientProvider>
  )
}

test.each(['chat', 'responses', 'anthropic'] as const)(
  'opens %s input details with the keyboard and copies the complete saved input',
  async (protocol) => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const prompt = `# Saved input\n${'Long prompt line\n'.repeat(80)}<script>alert(1)</script>\nFinal prompt line`
    const effort = 'medium'
    renderResult(
      { protocol, effort, input_tokens: 9749, max_output_tokens: 65536 },
      prompt
    )
    const input = screen.getByRole('button', { name: 'View input details' })
    input.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Input details' })
    expect(within(dialog).getByText('Upstream reported')).toBeInTheDocument()
    expect(dialog.querySelector('pre')?.textContent).toBe(prompt)
    expect(dialog.querySelector('script')).toBeNull()
    await user.click(
      within(dialog).getByRole('button', { name: 'Copy prompt' })
    )
    expect(copy).toHaveBeenLastCalledWith(prompt)
    await user.click(
      within(dialog).getByRole('tab', { name: 'Request parameters' })
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Copy request parameters' })
    )
    expect(JSON.parse(copy.mock.calls.at(-1)?.[0] ?? '{}')).toEqual({
      base_url: 'https://example.com/v1',
      model: 'test-model',
      protocol,
      ...{
        anthropic: { output_config: { effort } },
        responses: { reasoning: { effort } },
        chat: { reasoning_effort: effort },
      }[protocol],
      prompt,
      [{
        chat: 'max_completion_tokens',
        responses: 'max_output_tokens',
        anthropic: 'max_tokens',
      }[protocol]]: 65536,
    })
    expect(
      within(dialog).getByText(
        'Saved settings, not a raw request capture. Authentication headers and API keys are excluded.'
      )
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(comparisonRequest).not.toHaveBeenCalled()
  }
)

test.each([
  {
    status: 'running' as const,
    tokens_estimated: true,
    label: 'Includes estimates',
  },
  { status: 'queued' as const, tokens_estimated: false, label: 'Queued' },
  {
    status: 'failed' as const,
    tokens_estimated: false,
    input_tokens: 0,
    output_tokens: 0,
    label: 'Not available',
  },
])(
  'labels input statistics honestly for $status tasks',
  async ({ label, ...attempt }) => {
    renderResult(attempt)
    fireEvent.click(screen.getByRole('button', { name: 'View input details' }))
    const dialog = await screen.findByRole('dialog', { name: 'Input details' })
    expect(within(dialog).getByText(label)).toBeInTheDocument()
    expect(within(dialog).queryByText('Upstream reported')).toBeNull()
  }
)

test.each([
  '',
  'invalid artwork: no_html',
  'invalid artwork: no_svg',
  'upstream stream ended before completion',
])(
  'previews and copies full raw output, preserving diagnostics: %s',
  async (error) => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    vi.mocked(useInViewport).mockReturnValue({
      ref: { current: null },
      inView: true,
    })
    const output = `# Result\n${'Long output line\n'.repeat(100)}<script>alert(1)</script>\nFinal line`
    const { container } = renderResult({
      output,
      error,
      status: error ? 'failed' : 'succeeded',
    })
    await user.click(
      await screen.findByRole('button', { name: 'Copy full output' })
    )
    await waitFor(() => expect(copy).toHaveBeenCalledWith(output))
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('pre:last-child')?.textContent).toBe(output)
    if (error) expect(screen.getByText(error)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('pre:last-child')?.textContent).toBe(output)
    await user.click(
      within(dialog).getByRole('button', { name: 'Copy full output' })
    )
    expect(copy).toHaveBeenLastCalledWith(output)
    expect(
      within(dialog).queryByRole('button', { name: 'View source' })
    ).toBeNull()
  }
)

test('keeps complete HTML in the sandboxed artwork preview', async () => {
  vi.mocked(useInViewport).mockReturnValue({
    ref: { current: null },
    inView: true,
  })
  const html = '<!DOCTYPE html><html><body>HTML without SVG</body></html>'
  renderResult({ output: `\`\`\`html\n${html}\n\`\`\``, html })
  await waitFor(() =>
    expect(screen.getByTitle('test-model')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('HTML without SVG')
    )
  )
  expect(screen.queryByRole('button', { name: 'Copy full output' })).toBeNull()
})

test('opening details loads full output even when the card is outside the viewport', async () => {
  renderResult({ output: 'Offscreen output' })
  expect(comparisonRequest).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(
    await within(await screen.findByRole('dialog')).findByText(
      'Offscreen output'
    )
  ).toBeInTheDocument()
  expect(comparisonRequest).toHaveBeenCalledWith('/attempts/1')
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

test.each(['responses', 'anthropic'])(
  'submits independent %s groups with shared prompt, concurrency three and twenty minute timeout',
  async (protocol) => {
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
      target: { value: protocol },
    })
    fireEvent.change(screen.getAllByLabelText('Maximum output tokens')[1], {
      target: { value: '65536' },
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
              protocol,
              effort: 'medium',
              max_output_tokens: 65536,
            }),
          ],
        })
      )
    )
    expect(
      localStorage.getItem('degradation-watch:self-test-settings') ?? ''
    ).not.toContain('key-one')
  }
)

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

test('incomplete output keeps copyable text and puts the full upstream diagnostic behind a disclosure', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  vi.mocked(useInViewport).mockReturnValue({
    ref: { current: null },
    inView: true,
  })
  const output = '<html>partial output'
  const error = JSON.stringify({
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    },
  })
  renderResult({
    status: 'incomplete',
    output,
    error,
    output_tokens: 8192,
    max_output_tokens: 32768,
  })
  expect(screen.getByText('Output incomplete')).toBeInTheDocument()
  expect(
    await screen.findByText(
      'Output limit reached. Generated content is preserved. Load this round into the form and increase the output limit to test again.'
    )
  ).toBeInTheDocument()
  await user.click(
    await screen.findByRole('button', { name: 'Copy full output' })
  )
  expect(copy).toHaveBeenLastCalledWith(output)
  const summary = screen.getByText('Upstream diagnostic')
  const details = summary.closest('details')
  if (!details) throw new Error('Missing diagnostic disclosure')
  expect(details.open).toBe(false)
  await user.click(summary)
  expect(details.open).toBe(true)
  expect(within(details).getByText(error)).toBeInTheDocument()
  await user.click(within(details).getByRole('button'))
  expect(copy).toHaveBeenLastCalledWith(error)
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
})

test('an incomplete content-filter response is not labeled as an output limit merely because it includes max_output_tokens', async () => {
  const error = JSON.stringify({
    type: 'response.incomplete',
    response: {
      max_output_tokens: 32768,
      incomplete_details: { reason: 'content_filter' },
    },
  })
  renderResult({ status: 'incomplete', error })
  expect(
    await screen.findByText(
      'The upstream response is incomplete. Generated content is preserved; see the diagnostic for the reason.'
    )
  ).toBeInTheDocument()
  expect(
    screen.queryByText(
      'Output limit reached. Generated content is preserved. Load this round into the form and increase the output limit to test again.'
    )
  ).toBeNull()
})

test('switching a saved group to Anthropic keeps model discovery and native effort available', async () => {
  vi.mocked(comparisonRequest).mockImplementation(async (path) => {
    if (path === '/profiles') {
      return [
        {
          id: 7,
          name: 'Saved gateway',
          base_url: 'https://example.com/v1',
          model: 'claude-opus-5-5',
          protocol: 'chat',
          effort: 'medium',
          max_output_tokens: 32768,
          remember_key: true,
          has_saved_key: true,
        },
      ]
    }
    if (path === '/models') return ['claude-opus-5-5']
    return []
  })
  renderPanel()
  await screen.findByDisplayValue('Saved gateway')
  fireEvent.change(screen.getByLabelText('Protocol'), {
    target: { value: 'anthropic' },
  })
  const effort = screen.getByLabelText('Reasoning effort')
  expect(effort).toBeEnabled()
  expect(effort).toHaveValue('medium')
  expect(within(effort).queryByRole('option', { name: 'none' })).toBeNull()
  fireEvent.change(effort, { target: { value: 'max' } })
  const fetch = screen.getByRole('button', { name: 'Fetch models' })
  expect(fetch).toBeEnabled()
  fireEvent.click(fetch)
  await screen.findByLabelText('Fetched models')
  expect(comparisonRequest).toHaveBeenCalledWith(
    '/models',
    'post',
    expect.objectContaining({
      id: 7,
      protocol: 'anthropic',
      effort: 'max',
      api_key: '',
      has_saved_key: true,
    })
  )
  fireEvent.change(screen.getByLabelText('Protocol'), {
    target: { value: 'responses' },
  })
  expect(effort).toHaveValue('max')
  expect(fetch).toBeEnabled()
  fireEvent.change(effort, { target: { value: 'minimal' } })
  fireEvent.change(screen.getByLabelText('Protocol'), {
    target: { value: 'anthropic' },
  })
  expect(effort).toHaveValue('')
  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'https://other.example/v1' },
  })
  expect(fetch).toBeDisabled()
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: 'new-fixture-key' },
  })
  expect(fetch).toBeEnabled()
})

test.each(['chat', 'responses'])(
  'validates known model effort and submits max in %s',
  async (protocol) => {
    vi.mocked(comparisonRequest).mockImplementation(async (path, method) => {
      if (path === '/rounds' && method === 'post') return { id: 12 }
      if (path === '/rounds/12') {
        return {
          round: { id: 12, status: 'completed', prompt: 'Draw' },
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
      target: { value: 'https://example.com/v1' },
    })
    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'fixture-key' },
    })
    fireEvent.change(screen.getByLabelText('Protocol'), {
      target: { value: protocol },
    })
    const effort = screen.getByLabelText('Reasoning effort')
    fireEvent.change(effort, { target: { value: 'none' } })
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gpt-6.1-sol' },
    })
    expect(within(effort).getByRole('option', { name: 'none' })).toBeDisabled()
    expect(
      within(effort).getByRole('option', { name: 'minimal' })
    ).toBeDisabled()
    fireEvent.click(screen.getByText('Start comparison'))
    await screen.findByText(
      'Choose a supported reasoning effort for this model.'
    )
    expect(comparisonRequest).not.toHaveBeenCalledWith(
      '/rounds',
      'post',
      expect.anything()
    )
    fireEvent.change(effort, { target: { value: 'max' } })
    fireEvent.click(screen.getByText('Start comparison'))
    await waitFor(() =>
      expect(comparisonRequest).toHaveBeenCalledWith(
        '/rounds',
        'post',
        expect.objectContaining({
          groups: [expect.objectContaining({ protocol, effort: 'max' })],
        })
      )
    )
  }
)

test.each(['chat', 'responses', 'anthropic'] as const)(
  'omits default effort from copied %s settings',
  async (protocol) => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    renderResult({ protocol, effort: '' })
    await user.click(screen.getByRole('button', { name: 'View input details' }))
    const dialog = await screen.findByRole('dialog', { name: 'Input details' })
    await user.click(
      within(dialog).getByRole('tab', { name: 'Request parameters' })
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Copy request parameters' })
    )
    const settings = JSON.parse(copy.mock.calls.at(-1)?.[0] ?? '{}')
    expect(settings).not.toHaveProperty('reasoning_effort')
    expect(settings).not.toHaveProperty('reasoning')
    expect(settings).not.toHaveProperty('output_config')
  }
)
