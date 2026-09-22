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
import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ImageCaptcha } from '../image-captcha'

const png = 'data:image/png;base64,iVBORw0KGgo='

function Harness() {
  const [code, setCode] = useState('')
  const [, setId] = useState('')
  return (
    <ImageCaptcha
      purpose='login'
      value={code}
      onChange={setCode}
      onCaptchaChange={setId}
    />
  )
}

function renderCaptcha() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/captcha') {
      return {
        data: {
          success: true,
          data: { captcha_id: 'cap-1', image: png, expires_in: 300 },
        },
      } as never
    }
    return { data: { success: true, data: {} } } as never
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('image captcha row layout', () => {
  it('keeps the challenge image, the answer field and refresh on one row', async () => {
    renderCaptcha()

    const image = await screen.findByAltText('Image captcha')
    const field = screen.getByLabelText('Image captcha code')
    const refresh = screen.getByRole('button', {
      name: 'Refresh image captcha',
    })

    expect(field.parentElement).toBe(image.parentElement)
    expect(refresh.parentElement).toBe(image.parentElement)
  })

  it('reserves the challenge slot before the image arrives so the row keeps its shape', () => {
    const { container } = renderCaptcha()

    const placeholder = container.querySelector('[aria-hidden="true"]')

    expect(placeholder).not.toBeNull()
    expect(screen.queryByAltText('Image captcha')).toBeNull()
  })

  it('labels the answer field so the row stays operable by keyboard', async () => {
    renderCaptcha()

    const field = await screen.findByLabelText('Image captcha code')

    await waitFor(() => expect(field).toBeEnabled())
    expect(field).toHaveAttribute('maxlength', '6')
    expect(field).toHaveAttribute('inputmode', 'numeric')
  })
})
