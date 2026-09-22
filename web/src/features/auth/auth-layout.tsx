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
import { useTranslation } from 'react-i18next'

import { Skeleton } from '@/components/ui/skeleton'
import { useSystemConfig } from '@/hooks/use-system-config'

import { AuthBackdrop } from './components/auth-backdrop'

type AuthLayoutProps = {
  children: React.ReactNode
  /** One plain sentence naming what this deployment does for the visitor. */
  lede?: string
}

export function AuthLayout(props: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()

  return (
    <div className='bg-background relative isolate min-h-svh overflow-hidden'>
      <AuthBackdrop />

      <div className='relative z-10 min-h-svh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]'>
        <aside className='flex flex-col gap-6 px-6 pt-10 sm:px-10 lg:justify-between lg:gap-12 lg:px-14 lg:py-16'>
          <Link
            to='/'
            className='flex w-fit items-center gap-3 transition-opacity hover:opacity-80'
          >
            {loading ? (
              <Skeleton className='size-9 rounded-full' />
            ) : (
              <img
                src={logo}
                alt={t('Logo')}
                className='size-9 rounded-full object-cover'
              />
            )}
          </Link>

          <div className='max-w-[30ch]'>
            {loading ? (
              <Skeleton className='h-8 w-56 lg:h-12 lg:w-64' />
            ) : (
              <h1 className='text-[1.75rem] leading-[1.05] font-semibold tracking-[-0.02em] text-balance lg:text-[clamp(2rem,3.4vw,2.9rem)] lg:leading-[1.02] lg:tracking-[-0.03em]'>
                {systemName}
              </h1>
            )}
            {props.lede && (
              <p className='text-muted-foreground mt-3 text-sm leading-relaxed text-pretty lg:mt-5 lg:text-base'>
                {props.lede}
              </p>
            )}
          </div>
        </aside>

        <main className='flex justify-center px-4 py-10 sm:px-10 lg:items-center lg:px-14 lg:py-16'>
          <div className='auth-panel border-border/60 bg-card/75 w-full max-w-[27rem] rounded-2xl border p-6 backdrop-blur-xl sm:p-8'>
            {props.children}
          </div>
        </main>
      </div>
    </div>
  )
}
