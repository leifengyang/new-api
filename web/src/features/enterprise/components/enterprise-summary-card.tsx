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
import { BarChart3, Users, WalletCards } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { IconBadge, type IconBadgeTone } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { generateAffiliateLink } from '@/features/wallet/lib'
import { formatQuota } from '@/lib/format'

import type { EnterpriseProfile } from '../types'

interface EnterpriseSummaryCardProps {
  profile: EnterpriseProfile | null
  loading?: boolean
}

/**
 * 控制台首页的头一块：企业自己的余额、已用、成员名额，以及给成员用的邀请链接。
 * 余额是这家企业能往下发的钱；成员钱包是各自独立的，不在这里汇总。
 */
export function EnterpriseSummaryCard(props: EnterpriseSummaryCardProps) {
  const { t } = useTranslation()

  if (props.loading) {
    return (
      <div className='space-y-4'>
        <div className='grid grid-cols-3 divide-x rounded-lg border'>
          {['balance', 'usage', 'members'].map((key) => (
            <div key={key} className='min-w-0 px-2.5 py-2.5 sm:px-5 sm:py-4'>
              <Skeleton className='h-3.5 w-full' />
              <Skeleton className='mt-2 h-6 w-full sm:h-7' />
            </div>
          ))}
        </div>
        <Skeleton className='h-20 w-full rounded-lg' />
      </div>
    )
  }

  const profile = props.profile
  const stats: {
    label: string
    value: string
    description: string
    icon: typeof WalletCards
    tone: IconBadgeTone
  }[] = [
    {
      label: t('Available Balance'),
      value: formatQuota(profile?.quota ?? 0),
      description: t('Quota this enterprise can still hand out'),
      icon: WalletCards,
      tone: 'success',
    },
    {
      label: t('Total Usage'),
      value: formatQuota(profile?.used_quota ?? 0),
      description: t('Quota this enterprise account has consumed itself'),
      icon: BarChart3,
      tone: 'info',
    },
    {
      label: t('Members'),
      value: `${profile?.member_count ?? 0} / ${profile?.member_limit ?? 0}`,
      description: t('Members used out of the limit set by the administrator'),
      icon: Users,
      tone: 'chart-4',
    },
  ]

  // 企业账号的推广码同时就是成员邀请码：带这个码注册进来的用户直接落到本企业
  // 名下，且不会与企业账号建立邀请返现关系（见服务端 ResolveRegistrationAdmission）。
  const inviteLink = profile?.invite_code
    ? generateAffiliateLink(profile.invite_code)
    : ''

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-3 divide-x rounded-lg border'>
        {stats.map((item) => (
          <div
            key={item.label}
            className='min-w-0 px-2.5 py-2.5 sm:px-5 sm:py-4'
          >
            <div className='flex items-center gap-1.5 sm:gap-2.5'>
              <IconBadge tone={item.tone} size='stat'>
                <item.icon />
              </IconBadge>
              <div className='text-muted-foreground truncate text-[11px] font-medium tracking-wider uppercase sm:text-xs'>
                {item.label}
              </div>
            </div>
            <div className='text-foreground mt-1.5 font-mono text-sm font-bold tracking-tight break-all tabular-nums sm:mt-2.5 sm:text-2xl'>
              {item.value}
            </div>
            <div className='text-muted-foreground/60 mt-1 hidden text-xs md:block'>
              {item.description}
            </div>
          </div>
        ))}
      </div>

      <div className='space-y-2 rounded-lg border p-4'>
        <div className='text-sm font-medium'>{t('Invite link')}</div>
        <div className='flex items-center gap-2'>
          <Input
            value={inviteLink}
            readOnly
            aria-label={t('Invite link')}
            className='border-muted bg-background/70 h-9 min-w-0 flex-1 font-mono text-xs'
          />
          {/* 推广码是建号时写入的必填列，正常不会为空；真为空时没什么可复制的，
              与其给一个复制空串的按钮，不如不显示。 */}
          {inviteLink ? (
            <CopyButton
              value={inviteLink}
              variant='outline'
              className='bg-background size-9 shrink-0'
              iconClassName='size-4'
              tooltip={t('Copy invite link')}
              aria-label={t('Copy invite link')}
            />
          ) : null}
        </div>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Users who register through this link join this enterprise automatically. They do not receive the platform welcome quota, so hand them quota from this balance before they can call the API.'
          )}
        </p>
      </div>
    </div>
  )
}
