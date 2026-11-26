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
import { t } from 'i18next'

import {
  getServerErrorMessage,
  getServerErrorSources,
} from '@/lib/server-error-message'

export function getCanvasErrorMessage(error: unknown): string {
  for (const source of getServerErrorSources(error)) {
    switch (source.code) {
      case 'CANVAS_SESSION_REQUIRED':
        return t('Session expired!')
      case 'CANVAS_AUTO_UNAVAILABLE':
        return t(
          'No automatic routing group is available for your account. Contact your administrator.'
        )
      case 'CANVAS_TOKEN_DELETED':
        return t(
          'Your canvas key was deleted. Create a replacement to continue.'
        )
      case 'CANVAS_TOKEN_DISABLED':
        return t(
          'Your canvas key is disabled. Enable it in API Keys to continue.'
        )
      case 'CANVAS_TOKEN_EXPIRED':
        return t(
          'Your canvas key has expired. Update its expiration in API Keys.'
        )
      case 'CANVAS_TOKEN_EXHAUSTED':
        return t(
          'Your canvas key has no quota remaining. Update it in API Keys.'
        )
      case 'CANVAS_TOKEN_GROUP':
        return t(
          'Your canvas key must use the auto group. Update its group in API Keys.'
        )
      case 'CANVAS_TOKEN_LIMIT':
        return t(
          'Your API key limit has been reached. Remove an unused key before opening the canvas.'
        )
      case 'CANVAS_TOKEN_NOT_DELETED':
        return t('Your canvas key already exists. Manage it in API Keys.')
      case 'CANVAS_INTERNAL_ERROR':
        return t(
          'The canvas service is temporarily unavailable. Please try again.'
        )
      case 'CANVAS_STORAGE_QUOTA_EXCEEDED':
        return t(
          'Your canvas storage is full. Delete unused projects or assets, or contact your administrator.'
        )
    }
  }
  return getServerErrorMessage(error, t('Unable to open canvas'))
}
