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
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatQuota } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import { reverseInviteRebate } from '../api'
import { REVERSE_REASON_MAX_LENGTH } from '../constants'
import { useInviteRebates } from './invite-rebates-provider'

export function ReverseRebateDialog() {
  const { t } = useTranslation()
  const { reversingRow, setReversingRow, triggerRefresh } = useInviteRebates()
  const [reason, setReason] = useState('')

  const reverse = useMutation({
    mutationFn: async (rebateId: number) => {
      const result = await reverseInviteRebate(rebateId, reason.trim())
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: () => {
      toast.success(t('Rebate reversed'))
      setReason('')
      setReversingRow(null)
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t('Failed to reverse the rebate'))
    },
  })

  // 撤销失败时保留已填写的理由，管理员可以直接改一改再重试；只有关闭或成功
  // 才清空，避免下一次打开时读到上一次的内容。
  const close = () => {
    setReason('')
    setReversingRow(null)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open && !reverse.isPending) {
      close()
    }
  }

  const canReverse = reason.trim().length > 0 && !reverse.isPending

  return (
    <Dialog
      open={reversingRow !== null}
      onOpenChange={handleOpenChange}
      title={t('Reverse this rebate?')}
      description={
        reversingRow
          ? t(
              'The {{amount}} credited to {{inviter}} is deducted from their balance. If their balance is lower, only what is left is recovered and the rest stays recorded as outstanding.',
              {
                amount: formatQuota(reversingRow.rebate_quota),
                inviter: reversingRow.inviter_name,
              }
            )
          : ''
      }
      bodyClassName='space-y-2'
      footer={
        <>
          <Button
            variant='outline'
            onClick={close}
            disabled={reverse.isPending}
          >
            {t('Cancel')}
          </Button>
          <Button
            variant='destructive'
            onClick={() => {
              if (reversingRow && canReverse) reverse.mutate(reversingRow.id)
            }}
            disabled={!canReverse}
          >
            {reverse.isPending ? (
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            ) : null}
            {reverse.isPending ? t('Reversing...') : t('Reverse Rebate')}
          </Button>
        </>
      }
    >
      <Label htmlFor='reverse-reason'>{t('Reason')}</Label>
      <Textarea
        id='reverse-reason'
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={REVERSE_REASON_MAX_LENGTH}
        placeholder={t('Why is this rebate being reversed?')}
        disabled={reverse.isPending}
        rows={3}
      />
      <p className='text-muted-foreground text-xs'>
        {t('The reason is stored with this row and in the audit log.')}
      </p>
    </Dialog>
  )
}
