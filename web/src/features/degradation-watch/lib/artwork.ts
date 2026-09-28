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
/**
 * Model output is untrusted HTML. It is only ever rendered inside an iframe
 * with `sandbox="allow-scripts"` (never `allow-same-origin`), so it runs in an
 * opaque origin with no access to the console's cookies or storage. The CSP
 * below additionally stops it from loading anything or phoning home: inline
 * script and style only, and inline SVG needs nothing else.
 */
export const ARTWORK_SANDBOX = 'allow-scripts'

export const ARTWORK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTWORK_CSP}">`

/**
 * Places the CSP meta ahead of everything the model wrote. A meta CSP only
 * applies to what comes after it, so it goes right after `<head>` when there
 * is one, otherwise right after `<html>`, otherwise at the very start.
 */
export function buildArtworkSrcDoc(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + CSP_META + html.slice(at)
  }
  const root = /<html[^>]*>/i.exec(html)
  if (root) {
    const at = root.index + root[0].length
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`
  }
  return CSP_META + html
}

export type ArtworkExtraction =
  | { ok: true; html: string }
  | { ok: false; reason: 'empty_content' | 'no_html' | 'no_svg' }

/** Mirrors the server's `extractDegradationWatchHtml` so a self-test is judged the same way. */
export function extractArtworkHtml(text: string): ArtworkExtraction {
  if (text.trim() === '') return { ok: false, reason: 'empty_content' }
  const lower = text.toLowerCase()
  let start = lower.indexOf('<!doctype html')
  if (start < 0) start = lower.indexOf('<html')
  const end = lower.lastIndexOf('</html>')
  if (start < 0 || end < start) return { ok: false, reason: 'no_html' }
  const html = text.slice(start, end + '</html>'.length)
  if (!html.toLowerCase().includes('<svg'))
    return { ok: false, reason: 'no_svg' }
  return { ok: true, html }
}

/** Labels for the reason codes the server stores; anything else is a raw upstream error. */
export const FAILURE_REASON_LABELS: Record<string, string> = {
  timeout: 'Timed out',
  empty_content: 'Empty response',
  no_html: 'No HTML in the answer',
  no_svg: 'HTML without SVG',
  upstream_error: 'Upstream error',
}

export function failureReasonLabel(reason: string): string | null {
  return FAILURE_REASON_LABELS[reason] ?? null
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds % 60)}s`
}

export function successRate(succeeded: number, total: number): number | null {
  if (total <= 0) return null
  return succeeded / total
}
