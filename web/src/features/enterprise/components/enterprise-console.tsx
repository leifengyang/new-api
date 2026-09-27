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
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { createServerError } from '@/lib/server-error-message'

import { getEnterpriseProfile } from '../api'
import { ERROR_MESSAGES } from '../constants'
import { CreateMemberDialog } from './dialogs/create-member-dialog'
import { MemberLimitsDialog } from './dialogs/member-limits-dialog'
import { ResetPasswordDialog } from './dialogs/reset-password-dialog'
import { TransferQuotaDialog } from './dialogs/transfer-quota-dialog'
import { EnterpriseMembersTable } from './enterprise-members-table'
import { EnterpriseProvider, useEnterprise } from './enterprise-provider'
import { EnterpriseSummaryCard } from './enterprise-summary-card'

function EnterpriseConsoleContent() {
  const { t } = useTranslation()
  const { setOpenDialog, activeMember, refreshTrigger } = useEnterprise()

  // 企业档案里的余额和名额是「划拨」和「新增成员」的前置条件，所以几个弹窗都要
  // 用到它；放在这一层取一次，顺手也成了整页的刷新开关。
  const profileQuery = useQuery({
    queryKey: ['enterprise', 'profile', refreshTrigger],
    queryFn: async () => {
      const result = await getEnterpriseProfile()
      if (!result.success) {
        throw createServerError(result, t(ERROR_MESSAGES.LOAD_PROFILE_FAILED))
      }
      return result.data ?? null
    },
  })

  const profile = profileQuery.data ?? null
  const memberLimitReached =
    profile !== null && profile.member_count >= profile.member_limit

  return (
    <>
      <SectionPageLayout fixedContent>
        <SectionPageLayout.Title>
          {t('Enterprise Console')}
        </SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <Button
            size='sm'
            onClick={() => setOpenDialog('create-member')}
            // 名额是服务端说了算（建号事务里再数一次），这里只是提前把按钮关掉，
            // 免得填完表单才被拒。
            disabled={memberLimitReached}
          >
            <Plus className='h-4 w-4' />
            {t('Add Member')}
          </Button>
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          <div className='space-y-4'>
            {/* 取不到档案时卡片会退化成「余额 0、名额 0」，那是在编数字；宁可
                明说失败并给一次重试。成员表自己有加载/空态，不受这里影响。 */}
            {profileQuery.isError ? (
              <ErrorState
                description={profileQuery.error.message}
                onRetry={() => void profileQuery.refetch()}
              />
            ) : (
              <EnterpriseSummaryCard
                profile={profile}
                loading={profileQuery.isLoading}
              />
            )}
            <EnterpriseMembersTable />
          </div>
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <CreateMemberDialog inviteCode={profile?.invite_code ?? ''} />
      <TransferQuotaDialog
        member={activeMember}
        enterpriseQuota={profile?.quota ?? 0}
      />
      <MemberLimitsDialog member={activeMember} />
      <ResetPasswordDialog member={activeMember} />
    </>
  )
}

export function EnterpriseConsole() {
  return (
    <EnterpriseProvider>
      <EnterpriseConsoleContent />
    </EnterpriseProvider>
  )
}
