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
import { useMutation } from '@tanstack/react-query'
import { Eye, KeyRound, Power, PowerOff, Wallet } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTableRowActionMenu } from '@/components/data-table/core/row-action-menu'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import { formatQuota } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import { updateEnterpriseMemberStatus, removeEnterpriseMember } from '../api'
import { ENTERPRISE_MEMBER_STATUS, ERROR_MESSAGES } from '../constants'
import type { EnterpriseMember } from '../types'
import { useEnterprise } from './enterprise-provider'

interface EnterpriseMemberActionsProps {
  row: EnterpriseMember
}

export function EnterpriseMemberActions(props: EnterpriseMemberActionsProps) {
  const { t } = useTranslation()
  const verification = useSecureVerification()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const { setOpenDialog, setActiveMember, triggerRefresh } = useEnterprise()
  const [confirmDisable, setConfirmDisable] = useState(false)

  const member = props.row
  const isEnabled = member.status === ENTERPRISE_MEMBER_STATUS.ENABLED

  // 停用会退回未使用的企业额度；成员状态操作均需完成安全验证。
  const setStatus = useMutation({
    mutationFn: async ({
      enabled,
      proofToken,
    }: {
      enabled: boolean
      proofToken: string
    }) => {
      const result = await updateEnterpriseMemberStatus(
        member.id,
        enabled,
        proofToken
      )
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: (result, { enabled }) => {
      if (enabled) {
        toast.success(
          t('{{username}} is enabled again', { username: member.username })
        )
      } else {
        const returned = result.data?.returned_quota ?? 0
        toast.success(
          t(
            '{{username}} is disabled and {{quota}} was returned to the enterprise balance',
            {
              username: member.username,
              quota: formatQuota(returned),
            }
          )
        )
      }
      setConfirmDisable(false)
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t(ERROR_MESSAGES.UPDATE_STATUS_FAILED))
    },
  })

  const removal = useMutation({
    mutationFn: async (proofToken: string) => {
      const result = await removeEnterpriseMember(member.id, proofToken)
      if (!result.success) throw createServerError(result)
    },
    onSuccess: () => {
      setConfirmRemove(false)
      triggerRefresh()
      toast.success(t('Member removed'))
    },
  })

  async function changeMembership(action: 'enable' | 'disable' | 'remove') {
    const proof = await verification.requestVerification({
      scope: 'enterprise.member.manage',
      context: { member_id: member.id, action },
      title: t('Verify your identity'),
    })
    if (!proof) return
    if (action === 'remove') removal.mutate(proof.proof_token)
    else {
      setStatus.mutate({
        enabled: action === 'enable',
        proofToken: proof.proof_token,
      })
    }
  }

  const openDialog = (
    dialog: 'transfer-quota' | 'member-limits' | 'reset-password'
  ) => {
    setActiveMember(member)
    setOpenDialog(dialog)
  }

  return (
    <>
      <DataTableRowActionMenu
        ariaLabel={t('Open menu')}
        contentClassName='w-52'
      >
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            openDialog('transfer-quota')
          }}
        >
          {t('Transfer Quota')}
          <DropdownMenuShortcut>
            <Wallet size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            openDialog('member-limits')
          }}
        >
          {t('Visible Range')}
          <DropdownMenuShortcut>
            <Eye size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            openDialog('reset-password')
          }}
        >
          {t('Reset Password')}
          <DropdownMenuShortcut>
            <KeyRound size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {isEnabled ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setConfirmDisable(true)
            }}
          >
            {t('Disable')}
            <DropdownMenuShortcut>
              <PowerOff size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={() => void changeMembership('enable')}
            disabled={setStatus.isPending}
          >
            {t('Enable')}
            <DropdownMenuShortcut>
              <Power size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setConfirmRemove(true)}>
          {t('Remove member')}
        </DropdownMenuItem>
      </DataTableRowActionMenu>

      <ConfirmDialog
        open={confirmDisable && !verification.isActive}
        onOpenChange={(open) => {
          if (!verification.isActive) setConfirmDisable(open)
        }}
        title={t('Disable {{username}}?', { username: member.username })}
        desc={t(
          'Sign-in and API access will be disabled. Unused enterprise funds ({{quota}}) return to the enterprise. Personal funds are retained.',
          { quota: formatQuota(member.enterprise_quota ?? 0) }
        )}
        confirmText={t('Disable')}
        destructive
        isLoading={setStatus.isPending}
        handleConfirm={() => void changeMembership('disable')}
      />
      <ConfirmDialog
        open={confirmRemove && !verification.isActive}
        onOpenChange={(open) => {
          if (!verification.isActive) setConfirmRemove(open)
        }}
        title={t('Remove member')}
        desc={t(
          'Return unused enterprise funds and remove enterprise restrictions. Personal funds and account status are retained.'
        )}
        confirmText={t('Remove member')}
        destructive
        isLoading={removal.isPending}
        handleConfirm={() => void changeMembership('remove')}
      />
      <SecureVerificationDialog {...verification.dialogProps} />
    </>
  )
}
