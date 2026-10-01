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
import { useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useAnnouncements } from '@/features/dashboard/hooks/use-status-data'
import type { AnnouncementItem } from '@/features/dashboard/types'
import { useAuthStore } from '@/stores/auth-store'

import { AnnouncementDetailModal } from './announcement-detail-dialog'

export function AnnouncementPopup(props: {
  items: AnnouncementItem[]
  userId?: number
  isHome: boolean
}) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  let announcement: AnnouncementItem | undefined
  let receiptKey = ''
  for (const item of props.items) {
    if (item.published !== true || !item.revision || !item.popupTarget) continue
    if (item.popupTarget === 'home' && !props.isHome) continue
    if (item.popupTarget === 'authenticated' && !props.userId) continue
    // Public home announcements have one browser receipt; private ones are per account.
    const audience =
      item.popupTarget === 'home' ? 'home' : `user-${props.userId}`
    const key = `announcement-popup:${audience}:${item.id}:${item.revision}`
    if (dismissed.has(key)) continue
    try {
      if (localStorage.getItem(key) === 'read') continue
    } catch {
      // In-memory receipts still prevent repeat popups when storage is unavailable.
    }
    announcement = item
    receiptKey = key
    break
  }

  const dismiss = () => {
    if (!receiptKey) return
    try {
      localStorage.setItem(receiptKey, 'read')
    } catch {
      // Browsers can disable storage.
    }
    setDismissed((previous) => new Set(previous).add(receiptKey))
  }

  return (
    <AnnouncementDetailModal
      open={Boolean(announcement)}
      announcement={announcement ?? null}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
      footer={<Button onClick={dismiss}>{t('Got it')}</Button>}
    />
  )
}

export function AnnouncementDelivery() {
  const userId = useAuthStore((state) => state.auth.user?.id)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const { items } = useAnnouncements()
  // Keep automatic dialogs out of the editor and authentication/setup flows.
  if (
    pathname.startsWith('/system-settings') ||
    pathname.startsWith('/sign-') ||
    pathname === '/setup'
  ) {
    return null
  }
  return (
    <AnnouncementPopup
      items={items}
      userId={userId}
      isHome={pathname === '/'}
    />
  )
}
