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
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { isChunkLoadError, recoverChunkLoadError } from '@/lib/chunk-recovery'

import { GeneralError } from '../general-error'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { go: vi.fn() } }),
}))

beforeEach(() => {
  sessionStorage.clear()
})

test('a browser exception is not reported as HTTP 500', () => {
  render(<GeneralError error={new TypeError('render failed')} />)
  expect(screen.queryByText('500')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Reload page' })
  ).toBeInTheDocument()
})

test('a real HTTP error keeps its status', () => {
  render(<GeneralError error={{ response: { status: 502 } }} />)
  expect(screen.getByText('502')).toBeInTheDocument()
})

test('rate limiting keeps its own explanation and does not trigger resource recovery', () => {
  render(<GeneralError error={{ response: { status: 429 } }} />)
  expect(screen.getByText('429')).toBeInTheDocument()
  expect(
    screen.getByRole('heading', { name: 'Too many requests' })
  ).toBeInTheDocument()
  expect(sessionStorage.length).toBe(0)
})

test('chunk recovery reloads once across remounts and builds, then offers a manual reload', () => {
  const error = new Error(
    'Loading chunk 68669 failed. (missing: /static/js/async/old.js)'
  )
  error.name = 'ChunkLoadError'
  const reload = vi.fn()
  expect(recoverChunkLoadError(error, reload)).toBe(true)
  expect(recoverChunkLoadError(error, reload)).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)
  render(<GeneralError error={error} />)
  expect(
    screen.getByRole('heading', { name: 'Page resources could not be loaded' })
  ).toBeInTheDocument()
  expect(screen.queryByText('500')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Reload page' })
  ).toBeInTheDocument()
})

test('offline or blocked storage cannot create a reload loop', () => {
  const error = new TypeError('Failed to fetch dynamically imported module')
  const reload = vi.fn()
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  expect(recoverChunkLoadError(error, reload)).toBe(false)
  online.mockReturnValue(true)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(recoverChunkLoadError(error, reload)).toBe(false)
  expect(reload).not.toHaveBeenCalled()
})

test.each([
  ['Loading CSS chunk 42 failed.', true],
  ['Importing a module script failed.', true],
  ['error loading dynamically imported module', true],
  ['Network Error', false],
  ['Cannot read properties of undefined', false],
])(
  'classifies resource loading error %s without treating ordinary failures as updates',
  (message, expected) => {
    expect(isChunkLoadError(new Error(message))).toBe(expected)
  }
)
