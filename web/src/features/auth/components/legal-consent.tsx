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
import type * as React from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

import type { SystemStatus } from '../types'

interface LegalConsentProps {
  status: SystemStatus | null
  checked: boolean
  onCheckedChange: (nextValue: boolean) => void
  className?: string
  /** Submit-time message shown when the visitor has not agreed yet. */
  error?: string
  /** Lets the form move focus here when submit stops on this control. */
  checkboxRef?: React.Ref<HTMLButtonElement>
}

export function LegalConsent(props: LegalConsentProps) {
  const { t } = useTranslation()
  const errorId = useId()
  const hasUserAgreement = Boolean(props.status?.user_agreement_enabled)
  const hasPrivacyPolicy = Boolean(props.status?.privacy_policy_enabled)

  if (!hasUserAgreement && !hasPrivacyPolicy) {
    return null
  }

  const handleChange = (value: boolean) => {
    props.onCheckedChange(value === true)
  }

  return (
    <div className={cn('grid gap-2', props.className)}>
      <div
        className={cn(
          'bg-muted/40 flex items-start gap-3 rounded-lg border p-3',
          props.error ? 'border-destructive' : 'border-border/60'
        )}
      >
        <Checkbox
          id='legal-consent'
          ref={props.checkboxRef}
          checked={props.checked}
          onCheckedChange={handleChange}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? errorId : undefined}
          className='mt-0.5'
        />
        <Label
          htmlFor='legal-consent'
          className='text-muted-foreground items-start gap-1 text-left text-xs leading-5 font-normal'
        >
          <span>
            {t('I have read and agree to the')}{' '}
            {hasUserAgreement && (
              <a
                href='/user-agreement'
                target='_blank'
                rel='noopener noreferrer'
                className='text-primary hover:underline'
              >
                {t('User Agreement')}
              </a>
            )}
            {hasUserAgreement && hasPrivacyPolicy && ` ${t('and the')} `}
            {hasPrivacyPolicy && (
              <a
                href='/privacy-policy'
                target='_blank'
                rel='noopener noreferrer'
                className='text-primary hover:underline'
              >
                {t('Privacy Policy')}
              </a>
            )}
            .
          </span>
        </Label>
      </div>
      {props.error && (
        <p id={errorId} role='alert' className='text-destructive text-xs'>
          {props.error}
        </p>
      )}
    </div>
  )
}
