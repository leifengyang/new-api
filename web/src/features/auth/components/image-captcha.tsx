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
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type * as React from 'react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getImageCaptcha } from '@/features/auth/api'

interface ImageCaptchaProps {
  purpose: 'login' | 'register'
  value: string
  onChange: (value: string) => void
  onCaptchaChange: (id: string) => void
  disabled?: boolean
  /** Submit-time message shown under the field when the code is missing. */
  error?: string
  /** Lets the form move focus here when submit stops on this field. */
  inputRef?: React.Ref<HTMLInputElement>
}

export function ImageCaptcha(props: ImageCaptchaProps) {
  const { t } = useTranslation()
  const onChange = props.onChange
  const onCaptchaChange = props.onCaptchaChange
  const fieldId = useId()
  const errorId = useId()
  const [revision, setRevision] = useState(0)
  const [expired, setExpired] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const captcha = useQuery({
    queryKey: ['image-captcha', props.purpose, fieldId, revision],
    queryFn: ({ signal }) => getImageCaptcha(props.purpose, signal),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorToast: false },
  })

  useEffect(() => {
    onChange('')
    onCaptchaChange(captcha.data?.captcha_id ?? '')
    if (!captcha.data) return
    const timer = window.setTimeout(() => {
      setExpired(true)
      onChange('')
      onCaptchaChange('')
    }, captcha.data.expires_in * 1000)
    return () => window.clearTimeout(timer)
  }, [captcha.data, onChange, onCaptchaChange])

  function refresh() {
    props.onChange('')
    props.onCaptchaChange('')
    setExpired(false)
    setImageFailed(false)
    setRevision((current) => current + 1)
  }

  const unavailable =
    captcha.isPending || captcha.isError || expired || imageFailed

  return (
    <div className='grid gap-2' aria-busy={captcha.isFetching}>
      <Label htmlFor={fieldId}>{t('Image captcha code')}</Label>
      <div className='flex items-center gap-2'>
        {captcha.data && !imageFailed ? (
          <img
            src={captcha.data.image}
            alt={t('Image captcha')}
            width={180}
            height={60}
            className='h-11 w-[8.25rem] shrink-0 rounded-lg border bg-white object-cover'
            onError={() => {
              setImageFailed(true)
              props.onChange('')
              props.onCaptchaChange('')
            }}
          />
        ) : (
          <div
            className='bg-muted h-11 w-[8.25rem] shrink-0 rounded-lg'
            aria-hidden='true'
          />
        )}
        <Input
          id={fieldId}
          ref={props.inputRef}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={t('6 digits')}
          autoComplete='off'
          spellCheck={false}
          inputMode='numeric'
          maxLength={6}
          disabled={props.disabled || unavailable}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? errorId : undefined}
          className='h-11 min-w-0 flex-1 px-3.5'
        />
        <Button
          type='button'
          variant='outline'
          size='icon'
          className='size-11 shrink-0'
          onClick={refresh}
          disabled={props.disabled || captcha.isFetching}
          aria-label={t('Refresh image captcha')}
        >
          <RefreshCw
            aria-hidden='true'
            className={captcha.isFetching ? 'animate-spin' : ''}
          />
        </Button>
      </div>
      {props.error && (
        <p id={errorId} role='alert' className='text-destructive text-xs'>
          {props.error}
        </p>
      )}
      {(captcha.isError || imageFailed) && (
        <p role='alert' className='text-destructive text-xs'>
          {t('Unable to load the image captcha. Please refresh.')}
        </p>
      )}
      {expired && (
        <p role='status' className='text-muted-foreground text-xs'>
          {t('The image captcha has expired. Please refresh.')}
        </p>
      )}
    </div>
  )
}
