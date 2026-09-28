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
import { extractArtworkHtml, failureReasonLabel } from './artwork'

/**
 * The self-test runs entirely in the browser: the request goes straight from
 * here to the user's own base URL with the user's own key, so the key never
 * touches our server. The price is CORS — an endpoint that does not allow
 * this origin fails before we see any response, and `fetch` only reports a
 * bare TypeError. That case is surfaced as `network` so the page can explain it.
 */
export interface SelfTestInput {
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort: string
  prompt: string
}

export type SelfTestFailure =
  | 'network'
  | 'http'
  | 'empty_content'
  | 'no_html'
  | 'no_svg'
  | 'aborted'

export interface SelfTestResult {
  id: string
  model: string
  reasoningEffort: string
  success: boolean
  failure?: SelfTestFailure
  /** HTTP status and upstream message when `failure` is `http`. */
  detail?: string
  html?: string
  elapsedMs: number
  reasoningTokens: number
  completionTokens: number
  createdAt: number
}

/** Accepts `https://host`, `https://host/v1` or a full `/chat/completions` URL. */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

interface StreamUsage {
  completion_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Accumulates `choices[0].delta.content` and the final usage from an SSE body. */
export function parseChatCompletionStream(body: string): {
  text: string
  usage: StreamUsage | null
} {
  let text = ''
  let usage: StreamUsage | null = null
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice('data:'.length).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const chunk = JSON.parse(payload)
      const delta = chunk?.choices?.[0]?.delta?.content
      if (typeof delta === 'string') text += delta
      const message = chunk?.choices?.[0]?.message?.content
      if (typeof message === 'string') text += message
      if (chunk?.usage) usage = chunk.usage
    } catch {
      // A partial or non-JSON line is skipped, same as the server side.
    }
  }
  return { text, usage }
}

export async function runSelfTest(
  input: SelfTestInput,
  signal: AbortSignal
): Promise<SelfTestResult> {
  const startedAt = Date.now()
  const base = {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    createdAt: Math.floor(startedAt / 1000),
    reasoningTokens: 0,
    completionTokens: 0,
  }
  const body: Record<string, unknown> = {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: input.prompt }],
  }
  if (input.reasoningEffort !== '')
    body.reasoning_effort = input.reasoningEffort

  let response: Response
  try {
    response = await fetch(resolveChatCompletionsUrl(input.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    return {
      ...base,
      success: false,
      failure: signal.aborted ? 'aborted' : 'network',
      elapsedMs: Date.now() - startedAt,
    }
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    return {
      ...base,
      success: false,
      failure: signal.aborted ? 'aborted' : 'network',
      elapsedMs: Date.now() - startedAt,
    }
  }
  const elapsedMs = Date.now() - startedAt

  if (!response.ok) {
    let message = raw.slice(0, 300)
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.error?.message === 'string')
        message = parsed.error.message
    } catch {
      // keep the raw prefix
    }
    return {
      ...base,
      success: false,
      failure: 'http',
      detail: `HTTP ${response.status}: ${message}`,
      elapsedMs,
    }
  }

  const { text, usage } = parseChatCompletionStream(raw)
  const tokens = {
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
  }
  const extracted = extractArtworkHtml(text)
  if (!extracted.ok) {
    return {
      ...base,
      ...tokens,
      success: false,
      failure: extracted.reason,
      elapsedMs,
    }
  }
  return { ...base, ...tokens, success: true, html: extracted.html, elapsedMs }
}

export const REASONING_EFFORTS = [
  '',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

/** Maps a self-test failure to the text shown on its grey card. */
export function describeSelfTestFailure(result: SelfTestResult): string {
  if (result.failure === 'network') return 'Blocked by CORS or unreachable'
  if (result.failure === 'aborted') return 'Stopped'
  if (result.failure === 'http') return result.detail ?? 'Upstream error'
  return failureReasonLabel(result.failure ?? '') ?? 'Failed'
}
