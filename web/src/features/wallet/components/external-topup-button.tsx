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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShoppingCart } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import { getPaymentGuide, recordPaymentGuide } from '../api'
import { PaymentGuideDialog } from './dialogs/payment-guide-dialog'

export function ExternalTopupButton(props: { url: string }) {
  const userId = useAuthStore((state) => state.auth.user?.id)
  return <PaymentGuideButton key={userId} userId={userId} url={props.url} />
}

function PaymentGuideButton(props: { url: string; userId?: number }) {
  const { t } = useTranslation()
  const userId = props.userId
  const client = useQueryClient()
  const queryKey = ['payment-guide', userId]
  const [openFor, setOpenFor] = useState<number | null>(null)
  const status = useQuery({
    queryKey,
    queryFn: getPaymentGuide,
    enabled: !!userId,
    staleTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  const record = useMutation({
    mutationFn: recordPaymentGuide,
    retry: false,
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, {
        ...data,
        show_guide: data.shown_count < 3,
      })
    },
    onError: (error) => handleServerError(error),
  })

  return (
    <>
      <Button
        variant='outline'
        aria-label={t('Online Topup')}
        disabled={!userId || status.isLoading || record.isPending}
        className='min-h-14 min-w-0 justify-start gap-2 rounded-lg px-3 py-2 text-left'
        render={
          <a href={props.url} target='_blank' rel='noopener noreferrer' />
        }
        onClick={(event) => {
          if (status.data?.show_guide === false) return
          event.preventDefault()
          if (!userId || record.isPending || openFor === userId) return
          setOpenFor(userId)
          record.mutate()
        }}
      >
        <ShoppingCart className='size-4' />
        <span className='flex min-w-0 flex-col items-start gap-0.5'>
          <span className='max-w-full truncate'>{t('Online Topup')}</span>
          <span className='text-muted-foreground max-w-full truncate text-[11px] leading-4 font-normal'>
            {t('Buy a code, then redeem below')}
          </span>
        </span>
      </Button>
      {openFor === userId && (
        <PaymentGuideDialog url={props.url} onClose={() => setOpenFor(null)} />
      )}
    </>
  )
}
