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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useAnnouncements } from '@/features/dashboard/hooks/use-status-data'
import { latestPopupAnnouncements } from '@/features/dashboard/lib/announcements'
import type {
  AnnouncementBanner,
  AnnouncementItem,
} from '@/features/dashboard/types'
import { useAuthStore } from '@/stores/auth-store'

import { AnnouncementBoardDialog } from './announcement-board-dialog'

export function AnnouncementPopup({
  items,
  banner,
  trigger,
  target,
  active = true,
  loading = false,
}: {
  items: AnnouncementItem[]
  banner?: AnnouncementBanner | null
  trigger: string | null
  target: 'home' | 'authenticated'
  active?: boolean
  loading?: boolean
}) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const visibleItems = latestPopupAnnouncements(items, target)
  const publishedBanner = banner?.published ? banner : null
  const hasContent =
    visibleItems.length > 0 || Boolean(publishedBanner?.imageUrl)
  useEffect(() => {
    // An empty response also completes this visit; later polling must not interrupt it.
    if (active && trigger && !loading && !hasContent) setDismissed(trigger)
  }, [active, trigger, loading, hasContent])
  const dismiss = () => setDismissed(trigger)
  return (
    <AnnouncementBoardDialog
      key={trigger}
      open={active && Boolean(trigger) && dismissed !== trigger && hasContent}
      items={visibleItems}
      banner={publishedBanner}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
      footer={<Button onClick={dismiss}>{t('Got it')}</Button>}
    />
  )
}

export function AnnouncementDelivery() {
  const userId = useAuthStore((state) => state.auth.user?.id)
  const loginSequence = useAuthStore((state) => state.auth.loginSequence)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const { items, banner, loading } = useAnnouncements()
  const excluded =
    pathname.startsWith('/system-settings') ||
    pathname.startsWith('/sign-') ||
    pathname === '/setup'
  return (
    <>
      {pathname === '/' && (
        <AnnouncementPopup
          loading={loading}
          items={items}
          banner={banner}
          target='home'
          trigger='home'
        />
      )}
      <AnnouncementPopup
        loading={loading}
        items={items}
        banner={banner}
        target='authenticated'
        trigger={
          userId && loginSequence > 0
            ? `login:${userId}:${loginSequence}`
            : null
        }
        active={Boolean(userId) && pathname !== '/' && !excluded}
      />
    </>
  )
}
