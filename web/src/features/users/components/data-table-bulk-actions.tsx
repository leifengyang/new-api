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
import type { Table } from '@tanstack/react-table'
import { Building2, GraduationCap, Trash2, UserRoundMinus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTableBulkActions as BulkActionsToolbar } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

import {
  batchDeleteUsers,
  updateUserEnterprise,
  updateUsersMemberLevelBatch,
} from '../api'
import {
  USER_MEMBER_LEVEL,
  USER_ROLE,
  canDeleteUser,
  getUserMemberLevel,
  isEnterpriseAccount,
  isEnterpriseMember,
} from '../constants'
import type { User } from '../types'
import { useUsers } from './users-provider'

interface DataTableBulkActionsProps {
  table: Table<User>
}

type MemberLevelTarget = {
  ids: number[]
  level: number
}

export function DataTableBulkActions({ table }: DataTableBulkActionsProps) {
  const { t } = useTranslation()
  const { triggerRefresh } = useUsers()
  const operatorRole = useAuthStore((state) => state.auth.user?.role ?? 0)
  const [target, setTarget] = useState<MemberLevelTarget | null>(null)
  const [deleteTargets, setDeleteTargets] = useState<User[] | null>(null)
  const [enterpriseTargets, setEnterpriseTargets] = useState<number[] | null>(
    null
  )
  const selectedRows = table.getFilteredSelectedRowModel().rows
  const verification = useSecureVerification()
  const { requestVerification } = verification

  const levelUpdate = useMutation({
    mutationFn: async (next: MemberLevelTarget) => {
      const result = await updateUsersMemberLevelBatch(next.ids, next.level)
      if (!result.success) throw createServerError(result)
      return next.ids.length
    },
    onSuccess: (count, next) => {
      toast.success(
        next.level === USER_MEMBER_LEVEL.INTERNAL
          ? t('Marked {{count}} users as internal members', { count })
          : t('Marked {{count}} users as external users', { count })
      )
      setTarget(null)
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t('Failed to update the member level'))
    },
  })

  // Every selected row already holds this level, so the update would only add a
  // no-op entry to the audit log.
  const allAtLevel = (level: number) =>
    selectedRows.length > 0 &&
    selectedRows.every((row) => getUserMemberLevel(row.original) === level)

  const deletion = useMutation({
    mutationFn: async ({
      targets,
      proofToken,
    }: {
      targets: User[]
      proofToken: string
    }) => {
      const result = await batchDeleteUsers(
        targets.map((user) => user.id),
        proofToken
      )
      if (!result.success) throw createServerError(result)
      return targets.length
    },
    onSuccess: (count, { targets }) => {
      toast.success(t('Successfully deleted {{count}} users', { count }))
      // Drop the deleted rows from the selection so the toolbar count keeps
      // matching the list; the refresh below is what removes them from it.
      table.setRowSelection((previous) => {
        const next = { ...previous }
        for (const user of targets) delete next[String(user.id)]
        return next
      })
      setDeleteTargets(null)
      triggerRefresh()
    },
    onError: (error, { targets }) => {
      handleServerError(
        error,
        t('Failed to delete {{count}} users', { count: targets.length })
      )
    },
  })

  // 标记企业账号没有批量接口：服务端一次只认一个账号，因为标记要走事务，取消
  // 标记还要把成员余额退回。这里逐个调用，最后按账号数汇报，中间某个失败不影响
  // 其余的。抛出异常（网络失败）仍然按整次操作失败处理。
  const enterpriseMark = useMutation({
    mutationFn: async (ids: number[]) => {
      let failed = 0
      for (const id of ids) {
        const result = await updateUserEnterprise(id, true)
        if (!result.success) failed += 1
      }
      return { total: ids.length, failed }
    },
    onSuccess: ({ total, failed }) => {
      if (failed === 0) {
        toast.success(
          t('Marked {{count}} users as enterprise accounts', { count: total })
        )
      } else {
        toast.error(
          t(
            '{{failed}} of {{count}} accounts could not be marked as enterprise accounts',
            { failed, count: total }
          )
        )
      }
      setEnterpriseTargets(null)
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t('Failed to update the enterprise account'))
    },
  })

  const openFor = (level: number) => {
    setTarget({ ids: selectedRows.map((row) => row.original.id), level })
  }

  // Deleting accounts cannot be undone, so the confirmation is followed by a
  // second check of the operator's identity. The proof is bound to this exact
  // selection on the server, and a cancelled prompt deletes nothing.
  const confirmDeletion = async () => {
    const targets = deleteTargets
    if (!targets?.length || deletion.isPending) return
    const proof = await requestVerification({
      scope: 'user.delete_batch',
      context: { user_ids: targets.map((user) => user.id) },
      title: t('Verify to delete {{count}} users', { count: targets.length }),
      description: t(
        'Complete the verification to delete the selected users. This action cannot be undone.'
      ),
    })
    if (!proof) return
    deletion.mutate({ targets, proofToken: proof.proof_token })
  }

  // The server rejects the whole batch when it holds an account at or above the
  // operator's role, so there is no point in offering the action.
  const hasUndeletableRow = selectedRows.some(
    (row) => !canDeleteUser(row.original, operatorRole)
  )

  const isInternal = target?.level === USER_MEMBER_LEVEL.INTERNAL

  // 服务端只放普通用户，而且已经是别人成员的不行；这两种选中了也做不成，所以
  // 直接不给点。已经是企业账号的行送过去只是空操作，从请求里剔除，只有全被
  // 剔除时才当作无事可做。
  const hasIneligibleEnterpriseRow = selectedRows.some(
    (row) =>
      row.original.role >= USER_ROLE.ADMIN || isEnterpriseMember(row.original)
  )
  const enterpriseMarkIds = selectedRows
    .filter((row) => !isEnterpriseAccount(row.original))
    .map((row) => row.original.id)
  const canMarkEnterprise =
    !hasIneligibleEnterpriseRow && enterpriseMarkIds.length > 0
  const enterpriseDisabled = !canMarkEnterprise || enterpriseMark.isPending
  // 点不了的时候 tooltip 得说清为什么，否则这个按钮就是「按了没反应」。
  let enterpriseHint = t('Mark as enterprise account')
  if (!canMarkEnterprise) {
    enterpriseHint = hasIneligibleEnterpriseRow
      ? t(
          'Administrators and users who already belong to an enterprise cannot become enterprise accounts.'
        )
      : t('Every selected account is already an enterprise account.')
  }

  return (
    <>
      <BulkActionsToolbar table={table} entityName='user'>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant='outline'
                size='icon'
                className='size-8'
                aria-label={t('Mark as internal member')}
                disabled={
                  levelUpdate.isPending ||
                  allAtLevel(USER_MEMBER_LEVEL.INTERNAL)
                }
                onClick={() => openFor(USER_MEMBER_LEVEL.INTERNAL)}
              />
            }
          >
            <GraduationCap aria-hidden='true' />
          </TooltipTrigger>
          <TooltipContent>{t('Mark as internal member')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant='outline'
                size='icon'
                className='size-8'
                aria-label={t('Mark as external user')}
                disabled={
                  levelUpdate.isPending ||
                  allAtLevel(USER_MEMBER_LEVEL.EXTERNAL)
                }
                onClick={() => openFor(USER_MEMBER_LEVEL.EXTERNAL)}
              />
            }
          >
            <UserRoundMinus aria-hidden='true' />
          </TooltipTrigger>
          <TooltipContent>{t('Mark as external user')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              // 这里用 aria-disabled 而不是 disabled：被禁用的按钮不派发指针
              // 事件，说明原因的 tooltip 就弹不出来。同 channels 的批量操作栏。
              <Button
                variant='outline'
                size='icon'
                className={cn(
                  'size-8',
                  enterpriseDisabled && 'cursor-not-allowed opacity-50'
                )}
                aria-label={t('Mark as enterprise account')}
                aria-disabled={enterpriseDisabled}
                onClick={() => {
                  if (enterpriseDisabled) return
                  setEnterpriseTargets(enterpriseMarkIds)
                }}
              />
            }
          >
            <Building2 aria-hidden='true' />
          </TooltipTrigger>
          <TooltipContent>{enterpriseHint}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant='destructive'
                size='icon'
                className='size-8'
                aria-label={t('Delete selected users')}
                disabled={
                  deletion.isPending ||
                  verification.isActive ||
                  hasUndeletableRow
                }
                onClick={() =>
                  setDeleteTargets(selectedRows.map((row) => row.original))
                }
              />
            }
          >
            <Trash2 aria-hidden='true' />
          </TooltipTrigger>
          <TooltipContent>{t('Delete selected users')}</TooltipContent>
        </Tooltip>
      </BulkActionsToolbar>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !levelUpdate.isPending) setTarget(null)
        }}
        title={
          isInternal
            ? t('Mark {{count}} users as internal members?', {
                count: target?.ids.length ?? 0,
              })
            : t('Mark {{count}} users as external users?', {
                count: target?.ids.length ?? 0,
              })
        }
        desc={
          isInternal
            ? t(
                'They earn an invite rebate from the top-ups of the users they invite directly, plus a share of the top-ups made by the users those invitees bring in.'
              )
            : t(
                'They keep earning an invite rebate from the top-ups of the users they invite directly, at the external rate, and the first internal member above them also earns from those top-ups. Rebates already credited are not reversed.'
              )
        }
        confirmText={levelUpdate.isPending ? t('Saving...') : t('Confirm')}
        isLoading={levelUpdate.isPending}
        disabled={!target?.ids.length}
        handleConfirm={() => {
          if (target && !levelUpdate.isPending) {
            levelUpdate.mutate(target)
          }
        }}
      />
      <ConfirmDialog
        open={enterpriseTargets !== null}
        onOpenChange={(open) => {
          if (!open && !enterpriseMark.isPending) setEnterpriseTargets(null)
        }}
        title={t('Mark {{count}} users as enterprise accounts?', {
          count: enterpriseTargets?.length ?? 0,
        })}
        // 和行菜单里单个标记共用同一段说明：这段话本来就不分单复数。
        desc={t(
          'They keep their role: this only opens an enterprise console where they can create members, hand out quota from their own balance, and narrow what each member can use. Members are ordinary platform accounts that administrators still see and manage.'
        )}
        confirmText={enterpriseMark.isPending ? t('Saving...') : t('Confirm')}
        isLoading={enterpriseMark.isPending}
        disabled={!enterpriseTargets?.length}
        handleConfirm={() => {
          if (enterpriseTargets && !enterpriseMark.isPending) {
            enterpriseMark.mutate(enterpriseTargets)
          }
        }}
      />
      <ConfirmDialog
        destructive
        open={deleteTargets !== null && !verification.isActive}
        onOpenChange={(open) => {
          if (!open && !deletion.isPending && !verification.isActive) {
            setDeleteTargets(null)
          }
        }}
        title={t('Delete {{count}} users?', {
          count: deleteTargets?.length ?? 0,
        })}
        desc={t('This action cannot be undone.')}
        confirmText={deletion.isPending ? t('Deleting...') : t('Delete')}
        isLoading={deletion.isPending}
        disabled={!deleteTargets?.length}
        handleConfirm={confirmDeletion}
      />
      <SecureVerificationDialog {...verification.dialogProps} />
    </>
  )
}
