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
import { describe, expect, it } from 'vitest'

import { parseAliases, serializeAliases } from '../lib/aliases'
import {
  ARTWORK_CSP,
  buildArtworkSrcDoc,
  extractArtworkHtml,
} from '../lib/artwork'
import {
  parseChatCompletionStream,
  resolveChatCompletionsUrl,
} from '../lib/self-test'

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTWORK_CSP}">`

describe('extractArtworkHtml', () => {
  it('cuts the document out of surrounding prose and code fences', () => {
    const html = '<!DOCTYPE html><html><body><svg></svg></body></html>'
    expect(
      extractArtworkHtml(`Here you go:\n\`\`\`html\n${html}\n\`\`\``)
    ).toEqual({
      ok: true,
      html,
    })
  })

  it('reports why an answer does not count', () => {
    expect(extractArtworkHtml('  ')).toEqual({
      ok: false,
      reason: 'empty_content',
    })
    expect(extractArtworkHtml('<svg></svg>')).toEqual({
      ok: false,
      reason: 'no_html',
    })
    expect(extractArtworkHtml('<html><canvas></canvas></html>')).toEqual({
      ok: false,
      reason: 'no_svg',
    })
  })
})

describe('buildArtworkSrcDoc', () => {
  it('puts the CSP first inside an existing head', () => {
    expect(
      buildArtworkSrcDoc('<html><head><title>x</title></head></html>')
    ).toBe(`<html><head>${CSP_META}<title>x</title></head></html>`)
  })

  it('adds a head when the document has none', () => {
    expect(buildArtworkSrcDoc('<html><body></body></html>')).toBe(
      `<html><head>${CSP_META}</head><body></body></html>`
    )
    expect(buildArtworkSrcDoc('<svg></svg>')).toBe(`${CSP_META}<svg></svg>`)
  })
})

describe('resolveChatCompletionsUrl', () => {
  it('accepts a bare host, a versioned base, or the full endpoint', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
    expect(resolveChatCompletionsUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
    expect(
      resolveChatCompletionsUrl('https://api.example.com/v1/chat/completions')
    ).toBe('https://api.example.com/v1/chat/completions')
  })
})

describe('parseChatCompletionStream', () => {
  it('joins deltas, skips junk lines and keeps the final usage', () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"<html>"}}]}',
      ': keep-alive',
      'data: {not json',
      'data: {"choices":[{"delta":{"content":"</html>"}}]}',
      'data: {"choices":[],"usage":{"completion_tokens":42,"completion_tokens_details":{"reasoning_tokens":30}}}',
      'data: [DONE]',
    ].join('\n')
    expect(parseChatCompletionStream(body)).toEqual({
      text: '<html></html>',
      usage: {
        completion_tokens: 42,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    })
  })
})

describe('channel aliases', () => {
  it('round-trips, dropping blank aliases and tolerating bad JSON', () => {
    expect(serializeAliases({ '1': ' Line A ', '2': '  ' })).toBe(
      '{"1":"Line A"}'
    )
    expect(parseAliases('{"1":"Line A","2":3}')).toEqual({ '1': 'Line A' })
    expect(parseAliases('')).toEqual({})
    expect(parseAliases('[]')).toEqual({})
  })
})
