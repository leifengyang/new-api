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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  IconDiscord,
  IconGithub,
  IconLinuxDo,
  IconTelegram,
  IconWeChat,
} from '@/assets/brand-icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { useOAuthLogin } from '../hooks/use-oauth-login'
import type { SystemStatus } from '../types'

type OAuthProvidersProps = {
  status: SystemStatus | null
  disabled?: boolean
  className?: string
  onWeChatLogin?: () => void
  isWeChatLoading?: boolean
  redirectTo?: string
}

type ProviderButton = {
  key: string
  label: string
  onClick: () => void
  icon?: ReactNode
  disabled?: boolean
}

export function OAuthProviders(props: OAuthProvidersProps) {
  const { t } = useTranslation()
  const oauth = useOAuthLogin(props.status, props.redirectTo)
  const disabled = props.disabled ?? false
  const isWeChatLoading = props.isWeChatLoading ?? false

  const providerButtons: ProviderButton[] = []

  if (props.status?.wechat_login && props.onWeChatLogin) {
    providerButtons.push({
      key: 'wechat',
      label: t('Continue with WeChat'),
      onClick: props.onWeChatLogin,
      icon: <IconWeChat aria-hidden='true' className='h-4 w-4' />,
      disabled: isWeChatLoading,
    })
  }

  if (props.status?.github_oauth) {
    providerButtons.push({
      key: 'github',
      label: oauth.githubButtonText || t('Continue with GitHub'),
      onClick: oauth.handleGitHubLogin,
      icon: <IconGithub aria-hidden='true' className='h-4 w-4' />,
      disabled: oauth.githubButtonDisabled,
    })
  }

  if (props.status?.discord_oauth) {
    providerButtons.push({
      key: 'discord',
      label: t('Continue with Discord'),
      onClick: oauth.handleDiscordLogin,
      icon: <IconDiscord aria-hidden='true' className='h-4 w-4' />,
    })
  }

  if (props.status?.oidc_enabled) {
    const oidcDisplayName = props.status.oidc_display_name?.trim() || 'OIDC'
    providerButtons.push({
      key: 'oidc',
      label: t('Continue with {{name}}', {
        name: oidcDisplayName,
      }),
      onClick: oauth.handleOIDCLogin,
    })
  }

  if (props.status?.linuxdo_oauth) {
    providerButtons.push({
      key: 'linuxdo',
      label: t('Continue with LinuxDO'),
      onClick: oauth.handleLinuxDOLogin,
      icon: <IconLinuxDo aria-hidden='true' className='h-4 w-4' />,
    })
  }

  if (props.status?.telegram_oauth) {
    providerButtons.push({
      key: 'telegram',
      label: t('Continue with Telegram'),
      onClick: oauth.handleTelegramLogin,
      icon: <IconTelegram aria-hidden='true' className='h-4 w-4' />,
    })
  }

  const customProviders = props.status?.custom_oauth_providers
  if (customProviders && customProviders.length > 0) {
    for (const provider of customProviders) {
      providerButtons.push({
        key: `custom-${provider.slug}`,
        label: t('Continue with {{name}}', { name: provider.name }),
        onClick: () => oauth.handleCustomOAuthLogin(provider),
      })
    }
  }

  if (providerButtons.length === 0) return null

  /**
   * Branded providers collapse into one compact row of square buttons, which
   * keeps the form short. A lone icon would be a guessing game, so a single
   * branded provider stays in the labelled stack with the unbranded ones.
   */
  const branded = providerButtons.filter((provider) => provider.icon)
  const showIconRow = branded.length > 1
  const iconRow = showIconRow ? branded : []
  const labelledStack = showIconRow
    ? providerButtons.filter((provider) => !provider.icon)
    : providerButtons

  return (
    <div className={cn('space-y-4', props.className)}>
      <div className='flex items-center gap-3'>
        <span className='bg-border h-px flex-1' aria-hidden='true' />
        <span className='text-muted-foreground text-xs'>
          {t('Or continue with')}
        </span>
        <span className='bg-border h-px flex-1' aria-hidden='true' />
      </div>

      {iconRow.length > 0 && (
        <div className='flex flex-wrap justify-center gap-2'>
          {iconRow.map((provider) => (
            <Button
              key={provider.key}
              variant='outline'
              type='button'
              size='icon'
              aria-label={provider.label}
              title={provider.label}
              disabled={disabled || oauth.isLoading || provider.disabled}
              onClick={provider.onClick}
              className='size-11 [&_svg]:size-[1.15rem]'
            >
              {provider.icon}
            </Button>
          ))}
        </div>
      )}

      {labelledStack.length > 0 && (
        <div className='flex flex-col gap-2'>
          {labelledStack.map((provider) => (
            <Button
              key={provider.key}
              variant='outline'
              type='button'
              disabled={disabled || oauth.isLoading || provider.disabled}
              onClick={provider.onClick}
              className='h-11 w-full justify-center gap-2 text-[0.9375rem]'
            >
              {provider.icon}
              {provider.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
