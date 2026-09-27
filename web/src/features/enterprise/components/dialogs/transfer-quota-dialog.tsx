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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getCurrencyDisplay, getCurrencyLabel } from '@/lib/currency'
import {
  formatQuota,
  getEditableQuotaStep,
  parseQuotaFromDollars,
} from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import { transferEnterpriseMemberQuota } from '../../api'
import { ENTERPRISE_MEMBER_STATUS, ERROR_MESSAGES } from '../../constants'
import type { EnterpriseMember } from '../../types'
import { useEnterprise } from '../enterprise-provider'

interface TransferQuotaDialogProps {
  member: EnterpriseMember | null
  /** 企业账号当前余额，用来在提交前挡住超额划拨。 */
  enterpriseQuota: number
}

export function TransferQuotaDialog(props: TransferQuotaDialogProps) {
  const { t } = useTranslation()
  const { openDialog, setOpenDialog, setActiveMember, triggerRefresh } =
    useEnterprise()
  const [amount, setAmount] = useState('')

  const { meta: currencyMeta } = getCurrencyDisplay()
  const currencyLabel = getCurrencyLabel()
  const tokensOnly = currencyMeta.kind === 'tokens'

  const open = openDialog === 'transfer-quota' && props.member !== null
  const member = props.member

  const memberDisabled =
    member !== null && member.status !== ENTERPRISE_MEMBER_STATUS.ENABLED

  const amountValue = Number.parseFloat(amount) || 0
  const quotaValue = parseQuotaFromDollars(Math.abs(amountValue))
  const notEnoughBalance = quotaValue > props.enterpriseQuota
  const canSubmit = quotaValue > 0 && !notEnoughBalance && !memberDisabled

  const transfer = useMutation({
    mutationFn: async (quota: number) => {
      const result = await transferEnterpriseMemberQuota(member?.id ?? 0, quota)
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: (result) => {
      toast.success(
        t('Transferred {{quota}} to {{username}}', {
          quota: formatQuota(result.data?.transferred_quota ?? quotaValue),
          username: member?.username ?? '',
        })
      )
      close()
      // 划拨同时改动企业余额和成员钱包，两个查询都要重取。
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t(ERROR_MESSAGES.TRANSFER_QUOTA_FAILED))
    },
  })

  function close() {
    setAmount('')
    setActiveMember(null)
    setOpenDialog(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && !transfer.isPending) close()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={
        member
          ? t('Transfer Quota to {{username}}', { username: member.username })
          : t('Transfer Quota')
      }
      contentClassName='sm:max-w-md'
      bodyClassName='space-y-4'
      footer={
        <>
          <Button
            variant='outline'
            onClick={close}
            disabled={transfer.isPending}
          >
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => transfer.mutate(quotaValue)}
            disabled={!canSubmit || transfer.isPending}
          >
            {transfer.isPending ? t('Processing...') : t('Confirm')}
          </Button>
        </>
      }
    >
      <div className='text-muted-foreground space-y-1 text-sm'>
        <div>
          {t('Available Balance')}:{' '}
          <span className='text-foreground font-mono tabular-nums'>
            {formatQuota(props.enterpriseQuota)}
          </span>
        </div>
        {member ? (
          <div>
            {t('{{username}}’s balance', { username: member.username })}:{' '}
            <span className='text-foreground font-mono tabular-nums'>
              {formatQuota(member.quota)}
            </span>
          </div>
        ) : null}
      </div>

      <div className='space-y-2'>
        <Label htmlFor='enterprise-transfer-amount'>
          {t('Amount')} ({currencyLabel})
        </Label>
        <Input
          id='enterprise-transfer-amount'
          type='number'
          step={getEditableQuotaStep()}
          min={tokensOnly ? 1 : 0}
          placeholder={
            tokensOnly
              ? t('Enter amount in tokens')
              : t('Enter amount in {{currency}}', { currency: currencyLabel })
          }
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={transfer.isPending}
        />
      </div>

      {notEnoughBalance ? (
        <p className='text-destructive text-xs'>
          {t('The enterprise balance is not enough for this transfer.')}
        </p>
      ) : null}

      {/* 划给已停用的成员会被服务端挡下；先在这里说清楚，免得填完金额才报错。 */}
      {memberDisabled ? (
        <p className='text-destructive text-xs'>
          {t('This member is disabled. Enable them before transferring quota.')}
        </p>
      ) : null}

      {quotaValue > 0 && !notEnoughBalance ? (
        <p className='text-muted-foreground text-xs'>
          {t('After this transfer the enterprise balance will be {{quota}}.', {
            quota: formatQuota(props.enterpriseQuota - quotaValue),
          })}
        </p>
      ) : null}
    </Dialog>
  )
}
