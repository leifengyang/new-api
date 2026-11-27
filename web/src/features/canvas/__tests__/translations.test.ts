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
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const keys = [
  'My canvases',
  'Image workbench',
  'My assets',
  'Loading…',
  'Added to assets',
  'Choose a text or image asset.',
  'Describe the subject, style, composition, lighting, and purpose.',
  'Drop reference images here, or upload and paste them.',
  'Generate images',
  'Generated image {{number}}',
  'Generating…',
  'Generation results',
  'History',
  'Image generation failed. Please retry.',
  'Image generation history',
  'Interrupted',
  'Loading image history…',
  'No image models are available for your account.',
  'No images generated yet',
  'Paste',
  'Preview reference image {{name}}',
  'Prompt library',
  'Reference images',
  'Remove reference image {{name}}',
  'Reuse settings',
  'Saving reference images…',
  'Select an available image model before generating.',
  'Some image records could not be deleted. Please retry.',
  'Unable to download this image. Please retry.',
  'Unable to load image history. Please retry.',
  'Unable to save the image to assets. Please retry.',
  'Upload reference images',
  'Infinite Canvas',
  'Unable to open canvas',
  'Preparing your canvas…',
  'Canvas did not finish loading. Please retry.',
  'Create replacement canvas key',
  'Your previous canvas key was deleted. Create a new dedicated key to resume generation? Your saved work will be kept.',
  'Create and edit images on an infinite canvas.',
  'No automatic routing group is available for your account. Contact your administrator.',
  'Your canvas key was deleted. Create a replacement to continue.',
  'Your canvas key is disabled. Enable it in API Keys to continue.',
  'Your canvas key has expired. Update its expiration in API Keys.',
  'Your canvas key has no quota remaining. Update it in API Keys.',
  'Your canvas key must use the auto group. Update its group in API Keys.',
  'Your API key limit has been reached. Remove an unused key before opening the canvas.',
  'Your canvas key already exists. Manage it in API Keys.',
  'The canvas service is temporarily unavailable. Please try again.',
  'Your canvas storage is full. Delete unused projects or assets, or contact your administrator.',
]

const titles = {
  en: 'Infinite Canvas',
  zh: '无限画布',
  'zh-TW': '無限畫布',
  fr: 'Canevas infini',
  ja: '無限キャンバス',
  ru: 'Бесконечный холст',
  vi: 'Canvas vô hạn',
}

describe('canvas translations', () => {
  it.each(Object.entries(titles))(
    '%s preserves every canvas message and its native title',
    (locale, title) => {
      const filePath = path.resolve('src/i18n/locales', `${locale}.json`)
      const translation: Record<string, string> = JSON.parse(
        readFileSync(filePath, 'utf8')
      ).translation
      for (const key of keys) {
        expect(translation[key], key).toBeTruthy()
        expect(translation[key], key).not.toMatch(
          /\?{2,}|\uFFFD|[A-Za-z]\?[A-Za-z]/
        )
        expect(translation[key].match(/\{\{\w+\}\}/g) ?? [], key).toEqual(
          key.match(/\{\{\w+\}\}/g) ?? []
        )
      }
      expect(translation['Infinite Canvas']).toBe(title)
      expect(translation).not.toHaveProperty('Preparing your canvas?')
    }
  )
})
