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

/** The base URL callers point their OpenAI-compatible clients at. */
function baseEndpoint(): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/v1`
}

export function AuthLayout(props: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()
  const endpoint = baseEndpoint()

  return (
    <div className='bg-background relative isolate min-h-svh lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]'>
      <aside className='auth-stage relative isolate flex flex-col justify-between gap-10 overflow-hidden px-6 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-8 sm:px-10 lg:min-h-svh lg:gap-16 lg:px-14 lg:py-16'>
        <AuthBackdrop />

        <Link
          to='/'
          className='relative z-10 flex w-fit items-center gap-3 rounded-full transition-opacity hover:opacity-80'
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

        <div className='relative z-10 max-w-[34ch]'>
          {loading ? (
            <Skeleton className='h-8 w-56 lg:h-12 lg:w-64' />
          ) : (
            <h1 className='text-[1.75rem] leading-[1.05] font-semibold tracking-[-0.02em] text-balance lg:text-[clamp(2rem,3.4vw,2.9rem)] lg:leading-[1.02] lg:tracking-[-0.03em]'>
              {systemName}
            </h1>
          )}

          {endpoint && (
            <p className='auth-stage-endpoint mt-4 font-mono text-[clamp(0.8125rem,1.6vw,1.0625rem)] leading-snug tracking-tight break-all lg:mt-6'>
              {endpoint}
            </p>
          )}

          {props.lede && (
            <p className='auth-stage-dim mt-3 text-sm leading-relaxed text-pretty lg:text-base'>
              {props.lede}
            </p>
          )}
        </div>
      </aside>

      <main className='flex justify-center px-4 pt-10 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))] sm:px-10 lg:items-center lg:px-14 lg:py-16'>
        <div className='w-full max-w-[23rem]'>{props.children}</div>
      </main>
    </div>
  )
}
