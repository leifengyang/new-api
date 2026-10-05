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
import {
  ArrowRight,
  CircleAlert,
  CreditCard,
  Mail,
  WalletCards,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'

export function PaymentGuideDialog(props: {
  url: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const steps = [
    {
      title: t('Enter your email'),
      description: t(
        'Use your email at checkout so you can find your order later.'
      ),
      image: '/images/payment-guide/pay01.png',
      icon: Mail,
    },
    {
      title: t('Copy the card code'),
      description: t(
        'After payment, copy the card code from the payment success page or order details.'
      ),
      image: '/images/payment-guide/pay02.png',
      icon: CreditCard,
    },
    {
      title: t('Return here and redeem'),
      description: t(
        'Paste the card code into the redemption field below and select Redeem. Your balance updates after redemption.'
      ),
      image: '/images/payment-guide/pay03.png',
      icon: WalletCards,
    },
  ]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Read before paying')}
      description={t('Three steps to add funds with a card code')}
      contentClassName='sm:max-w-5xl'
      contentHeight='min(60dvh, 32rem)'
      bodyClassName='space-y-5'
      footer={
        <>
          <Button variant='outline' onClick={props.onClose}>
            {t('Close for now')}
          </Button>
          <Button
            render={
              <a href={props.url} target='_blank' rel='noopener noreferrer' />
            }
            onClick={props.onClose}
          >
            {t('Got it, continue to payment')}
            <ArrowRight className='size-4' />
          </Button>
        </>
      }
    >
      <div className='flex gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100'>
        <CircleAlert className='mt-0.5 size-5 shrink-0' />
        <div className='space-y-1'>
          <p className='text-base font-semibold'>
            {t('Payment alone does not credit your balance')}
          </p>
          <p className='text-sm'>
            {t(
              'Keep the card code after payment and redeem it on this page to receive your funds.'
            )}
          </p>
        </div>
      </div>
      <ol className='grid gap-4 md:grid-cols-3'>
        {steps.map((step, index) => (
          <li
            key={step.image}
            className='bg-muted/20 min-w-0 space-y-3 rounded-xl border p-3'
          >
            <div className='flex items-center gap-2'>
              <span className='bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold'>
                {index + 1}
              </span>
              <h3 className='text-sm font-semibold'>{step.title}</h3>
              <step.icon className='text-muted-foreground ml-auto size-4 shrink-0' />
            </div>
            <p className='text-muted-foreground min-h-16 text-sm leading-6'>
              {step.description}
            </p>
            <a
              href={step.image}
              target='_blank'
              rel='noopener noreferrer'
              className='focus-visible:ring-ring block overflow-hidden rounded-lg border bg-white outline-none focus-visible:ring-2'
              aria-label={t('View full-size image: {{step}}', {
                step: step.title,
              })}
            >
              <img
                src={step.image}
                alt={step.title}
                className='h-52 w-full object-contain'
                loading='lazy'
              />
              <span className='bg-muted/40 text-muted-foreground block border-t p-2 text-center text-xs'>
                {t('Click to view image')}
              </span>
            </a>
          </li>
        ))}
      </ol>
      <p className='text-muted-foreground text-xs leading-5'>
        {t(
          'This guide appears three times for new top-up users. Closing it only dismisses the current reminder.'
        )}
      </p>
    </Dialog>
  )
}
