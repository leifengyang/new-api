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
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'

import { CanvasSession } from './components/canvas-session'

export function CanvasPage() {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id)
  const session = useAuthStore((state) => state.auth.session)
  const workbench = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const appRoot = document.querySelector<HTMLElement>('#root')
    const previousInert = appRoot?.inert ?? false
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    if (appRoot) appRoot.inert = true
    document.body.style.overflow = 'hidden'
    workbench.current?.focus({ preventScroll: true })
    return () => {
      if (appRoot) appRoot.inert = previousInert
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [])
  // Dashboard container queries and route transitions establish containing
  // blocks. Mount outside them so this workspace fills the actual viewport.
  return createPortal(
    <section
      ref={workbench}
      tabIndex={-1}
      className='bg-background fixed inset-0 z-50 flex flex-col overflow-hidden'
      aria-label={t('Infinite Canvas')}
    >
      <header className='bg-background flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2'>
        <div className='flex min-w-0 items-center gap-3'>
          <Button
            variant='ghost'
            size='sm'
            role='link'
            render={<Link to='/dashboard' />}
          >
            <ArrowLeft aria-hidden='true' />
            {t('Return to dashboard')}
          </Button>
          <h1 className='truncate text-sm font-semibold'>
            {t('Infinite Canvas')}
          </h1>
        </div>
        <ProfileDropdown />
      </header>
      {userId && session ? (
        <CanvasSession
          key={`${userId}:${session.sid}`}
          userId={userId}
          sessionId={session.sid}
          expiresAt={session.expires_at}
        />
      ) : (
        <ErrorState description={t('Session expired!')} />
      )}
    </section>,
    document.body
  )
}
