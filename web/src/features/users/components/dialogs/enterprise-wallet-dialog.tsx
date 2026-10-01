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

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import {
  classifyEnterpriseBalance,
  removeEnterpriseMember,
} from '@/features/enterprise/api'
import { getCurrencyLabel } from '@/lib/currency'
import {
  formatQuota,
  getEditableQuotaStep,
  parseQuotaFromDollars,
} from '@/lib/format'
import { createServerError } from '@/lib/server-error-message'

import type { User } from '../../types'

interface EnterpriseWalletDialogProps {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

export function EnterpriseWalletDialog(props: EnterpriseWalletDialogProps) {
  const { t } = useTranslation()
  const verification = useSecureVerification()
  const [amount, setAmount] = useState('')
  const [removing, setRemoving] = useState(false)
  const frozen = props.user.enterprise_frozen_quota ?? 0
  const grant = props.user.enterprise_quota ?? 0
  const value = Number(amount)
  const quota =
    Number.isFinite(value) && value >= 0 ? parseQuotaFromDollars(value) : -1
  const valid =
    amount.trim() !== '' &&
    Number.isSafeInteger(quota) &&
    quota >= 0 &&
    quota <= frozen

  const mutation = useMutation({
    mutationFn: async (input: {
      action: 'remove' | 'classify'
      proof: string
      quota: number
    }) => {
      const result =
        input.action === 'remove'
          ? await removeEnterpriseMember(props.user.id, input.proof, true)
          : await classifyEnterpriseBalance(
              props.user.id,
              frozen,
              input.quota,
              input.proof
            )
      if (!result.success) throw createServerError(result)
    },
    onSuccess: () => {
      toast.success(t('Saved successfully'))
      setAmount('')
      setRemoving(false)
      props.onOpenChange(false)
      props.onSuccess()
    },
  })

  async function submit(action: 'remove' | 'classify') {
    if (mutation.isPending || (action === 'classify' && !valid)) return
    const context =
      action === 'classify'
        ? { member_id: props.user.id, action, quota, frozen }
        : { member_id: props.user.id, action }
    const proof = await verification.requestVerification({
      scope: 'enterprise.member.manage',
      context,
      title: t('Verify your identity'),
    })
    if (proof) mutation.mutate({ action, proof: proof.proof_token, quota })
  }

  return (
    <>
      <Dialog
        open={props.open && !verification.isActive && !removing}
        onOpenChange={(open) => {
          if (!verification.isActive && !removing && !mutation.isPending) {
            props.onOpenChange(open)
          }
        }}
        title={t('Enterprise balance management')}
        description={props.user.username}
        bodyClassName='space-y-4'
        footer={
          <Button variant='outline' onClick={() => props.onOpenChange(false)}>
            {t('Close')}
          </Button>
        }
      >
        <dl className='grid grid-cols-2 gap-2 text-sm'>
          <dt>{t('Enterprise funds')}</dt>
          <dd>{formatQuota(grant)}</dd>
          <dt>{t('Personal funds')}</dt>
          <dd>{formatQuota(props.user.quota - grant)}</dd>
          <dt>{t('Frozen historical balance')}</dt>
          <dd>{formatQuota(frozen)}</dd>
        </dl>
        {frozen > 0 && (
          <div className='space-y-3'>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Review the funding records before classifying this balance. The remainder becomes personal funds.'
              )}
            </p>
            <p className='text-muted-foreground text-sm'>
              {t(
                'For disabled members, enterprise funds return to the enterprise.'
              )}
            </p>
            <Label htmlFor={`enterprise-classify-${props.user.id}`}>
              {t('Enterprise share')} ({getCurrencyLabel()})
            </Label>
            <Input
              id={`enterprise-classify-${props.user.id}`}
              type='number'
              min='0'
              step={getEditableQuotaStep()}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={mutation.isPending}
            />
            {valid && (
              <p className='text-sm'>
                {t('Personal funds')}: {formatQuota(frozen - quota)}
              </p>
            )}
            <Button
              disabled={!valid || mutation.isPending}
              onClick={() => void submit('classify')}
            >
              {t('Confirm balance sources')}
            </Button>
          </div>
        )}
        {(props.user.enterprise_owner_id ?? 0) > 0 && (
          <Button
            variant='destructive'
            disabled={frozen > 0 || mutation.isPending}
            onClick={() => setRemoving(true)}
          >
            {t('Remove member')}
          </Button>
        )}
      </Dialog>
      <ConfirmDialog
        open={removing && !verification.isActive}
        onOpenChange={(open) => {
          if (!verification.isActive && !mutation.isPending) setRemoving(open)
        }}
        title={t('Remove member')}
        desc={t(
          'Return unused enterprise funds and remove enterprise restrictions. Personal funds and account status are retained.'
        )}
        confirmText={t('Remove member')}
        destructive
        isLoading={mutation.isPending}
        handleConfirm={() => void submit('remove')}
      />
      <SecureVerificationDialog {...verification.dialogProps} />
    </>
  )
}
