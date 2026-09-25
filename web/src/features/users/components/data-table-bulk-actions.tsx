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
import { GraduationCap, UserRoundMinus } from 'lucide-react'
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
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import { updateUsersMemberLevelBatch } from '../api'
import { USER_MEMBER_LEVEL, getUserMemberLevel } from '../constants'
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
  const [target, setTarget] = useState<MemberLevelTarget | null>(null)
  const selectedRows = table.getFilteredSelectedRowModel().rows

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

  const openFor = (level: number) => {
    setTarget({ ids: selectedRows.map((row) => row.original.id), level })
  }

  const isInternal = target?.level === USER_MEMBER_LEVEL.INTERNAL

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
                'They earn an invite rebate from the top-ups of the users they invite directly.'
              )
            : t(
                'They keep earning an invite rebate, but only on the first top-up made by each user they invite. Rebates already credited are not reversed.'
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
    </>
  )
}
