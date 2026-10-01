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
import { useNavigate } from '@tanstack/react-router'
import {
  User,
  Wallet,
  LogOut,
  Settings,
  ShieldCheck,
  ChevronsUpDown,
} from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { SignOutDialog } from '@/components/sign-out-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import useDialogState from '@/hooks/use-dialog'
import { useIsSidebarModuleVisible } from '@/hooks/use-sidebar-config'
import { useUserDisplay } from '@/hooks/use-user-display'
import { getUserAvatarFallback, getUserAvatarStyle } from '@/lib/avatar'
import { ROLE } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

const avatarFallbackClassName = 'font-semibold text-white'

type ProfileDropdownProps = {
  presentation?: 'avatar' | 'sidebar'
  onNavigate?: () => void
}

export function ProfileDropdown(props: ProfileDropdownProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useDialogState()
  const user = useAuthStore((state) => state.auth.user)
  const { displayName, roleLabel } = useUserDisplay(user)
  const isSuperAdmin = user?.role === ROLE.SUPER_ADMIN
  const isWalletVisible = useIsSidebarModuleVisible('/wallet')
  const isSecurityVisible = useIsSidebarModuleVisible('/security')
  const avatarName = user?.username || displayName
  const isSidebar = props.presentation === 'sidebar'
  const avatarFallback = getUserAvatarFallback(avatarName)
  const avatarFallbackStyle = useMemo(
    () => getUserAvatarStyle(avatarName),
    [avatarName]
  )

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              variant='ghost'
              aria-label={displayName}
              className={cn(
                'relative size-6 p-0',
                isSidebar &&
                  'h-14 w-full justify-start gap-2 rounded-lg px-2 text-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0'
              )}
            />
          }
        >
          <Avatar className={cn('size-6', isSidebar && 'size-8 rounded-lg')}>
            <AvatarFallback
              className={`${avatarFallbackClassName} text-[11px]`}
              style={avatarFallbackStyle}
            >
              {avatarFallback}
            </AvatarFallback>
          </Avatar>
          {isSidebar && (
            <>
              <span className='grid min-w-0 flex-1 gap-0.5 group-data-[collapsible=icon]:hidden'>
                <span className='truncate text-sm font-medium'>
                  {displayName}
                </span>
                <span className='text-muted-foreground truncate text-xs font-normal'>
                  {roleLabel}
                </span>
              </span>
              <ChevronsUpDown
                aria-hidden='true'
                className='ms-auto size-4 group-data-[collapsible=icon]:hidden'
              />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          side={isSidebar ? 'top' : 'bottom'}
          sideOffset={8}
          className='w-56'
        >
          <div className='flex items-center gap-2 px-1.5 py-1.5'>
            <Avatar className='size-8'>
              <AvatarFallback
                className={`${avatarFallbackClassName} text-xs`}
                style={avatarFallbackStyle}
              >
                {avatarFallback}
              </AvatarFallback>
            </Avatar>
            <div className='flex flex-1 flex-col gap-0.5 overflow-hidden'>
              <p className='text-foreground truncate text-sm font-medium'>
                {displayName}
              </p>
              <div className='flex items-center gap-1.5'>
                <span className='text-muted-foreground text-xs'>
                  {roleLabel}
                </span>
                {user?.group && (
                  <>
                    <span className='text-muted-foreground text-xs'>·</span>
                    <span className='text-muted-foreground truncate text-xs'>
                      {String(user.group)}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => {
              props.onNavigate?.()
              void navigate({ to: '/profile' })
            }}
          >
            <User className='size-4' />
            {t('Profile')}
          </DropdownMenuItem>

          {isSecurityVisible && (
            <DropdownMenuItem
              onClick={() => {
                props.onNavigate?.()
                void navigate({ to: '/security' })
              }}
            >
              <ShieldCheck className='size-4' />
              {t('Security & Access')}
            </DropdownMenuItem>
          )}

          {isWalletVisible && (
            <DropdownMenuItem
              onClick={() => {
                props.onNavigate?.()
                void navigate({ to: '/wallet' })
              }}
            >
              <Wallet className='size-4' />
              {t('Wallet')}
            </DropdownMenuItem>
          )}

          {isSuperAdmin && (
            <DropdownMenuItem
              onClick={() => {
                props.onNavigate?.()
                void navigate({
                  to: '/system-settings/site/$section',
                  params: { section: 'system-info' },
                })
              }}
            >
              <Settings className='size-4' />
              {t('System Settings')}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem variant='destructive' onClick={() => setOpen(true)}>
            <LogOut className='size-4' />
            {t('Sign out')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
