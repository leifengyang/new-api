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
import { formatQuota } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import { updateEnterpriseMemberStatus } from '../api'
import { ENTERPRISE_MEMBER_STATUS, ERROR_MESSAGES } from '../constants'
import type { EnterpriseMember } from '../types'
import { useEnterprise } from './enterprise-provider'

interface EnterpriseMemberActionsProps {
  row: EnterpriseMember
}

export function EnterpriseMemberActions(props: EnterpriseMemberActionsProps) {
  const { t } = useTranslation()
  const { setOpenDialog, setActiveMember, triggerRefresh } = useEnterprise()
  const [confirmDisable, setConfirmDisable] = useState(false)

  const member = props.row
  const isEnabled = member.status === ENTERPRISE_MEMBER_STATUS.ENABLED

  // 停用会把成员钱包里的余额退回企业账号，是一次真正的资金变动，所以走确认；
  // 启用只是把人放回来，没有副作用，点了就生效。
  const setStatus = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await updateEnterpriseMemberStatus(member.id, enabled)
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: (result, enabled) => {
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
            onClick={() => setStatus.mutate(true)}
            disabled={setStatus.isPending}
          >
            {t('Enable')}
            <DropdownMenuShortcut>
              <Power size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DataTableRowActionMenu>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t('Disable {{username}}?', { username: member.username })}
        desc={t(
          'They can no longer sign in or call the API, and the {{quota}} left in their wallet goes back to the enterprise balance. Nothing is deleted, so you can enable them again later.',
          { quota: formatQuota(member.quota) }
        )}
        confirmText={t('Disable')}
        destructive
        isLoading={setStatus.isPending}
        handleConfirm={() => setStatus.mutate(false)}
      />
    </>
  )
}
