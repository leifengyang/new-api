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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  RequestPromptButton,
  RequestPromptCaptureSwitch,
} from '../request-prompt'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([true, false])(
  'retired prompt widgets expose no controls or requests (root: %s)',
  (isRoot) => {
    render(
      <>
        <RequestPromptButton requestId='request-1' isRoot={isRoot} />
        <RequestPromptCaptureSwitch />
      </>
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
  }
)
