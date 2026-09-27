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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { handleServerError } from '@/lib/handle-server-error'
import { accountPasswordSchema } from '@/lib/password-policy'
import { createServerError } from '@/lib/server-error-message'

import { resetEnterpriseMemberPassword } from '../../api'
import { ERROR_MESSAGES } from '../../constants'
import type { EnterpriseMember } from '../../types'
import { useEnterprise } from '../enterprise-provider'

const schema = z
  .object({
    password: accountPasswordSchema,
    confirm: z.string(),
  })
  // 这一条不写 t()：FormMessage 会把消息文本当 i18n 键再翻一次，写键名即可。
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  })

type Values = z.infer<typeof schema>

interface ResetPasswordDialogProps {
  member: EnterpriseMember | null
}

export function ResetPasswordDialog(props: ResetPasswordDialogProps) {
  const { t } = useTranslation()
  const { openDialog, setOpenDialog, setActiveMember } = useEnterprise()

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  })

  const open = openDialog === 'reset-password' && props.member !== null

  const reset = useMutation({
    mutationFn: async (values: Values) => {
      const result = await resetEnterpriseMemberPassword(
        props.member?.id ?? 0,
        values.password
      )
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: () => {
      toast.success(t('Password reset successfully'))
      close()
    },
    onError: (error) => {
      handleServerError(error, t(ERROR_MESSAGES.RESET_PASSWORD_FAILED))
    },
  })

  // 关闭时清空，避免下一次打开时输入框里还留着上一个人（或上一次）的密码。
  function close() {
    form.reset({ password: '', confirm: '' })
    setActiveMember(null)
    setOpenDialog(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && !reset.isPending) close()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('Reset Password')}
      description={
        props.member
          ? t(
              'Set a new password for {{username}}. Their existing sessions are signed out, so they have to log in again with the new password.',
              { username: props.member.username }
            )
          : ''
      }
      contentClassName='sm:max-w-md'
      footer={
        <>
          <Button
            type='button'
            variant='outline'
            onClick={close}
            disabled={reset.isPending}
          >
            {t('Cancel')}
          </Button>
          <Button
            type='submit'
            form='enterprise-reset-password-form'
            disabled={reset.isPending}
          >
            {reset.isPending ? (
              <Loader2 className='size-4 animate-spin' />
            ) : null}
            {reset.isPending ? t('Saving...') : t('Reset Password')}
          </Button>
        </>
      }
    >
      <Form {...form}>
        <form
          id='enterprise-reset-password-form'
          onSubmit={form.handleSubmit((values) => reset.mutate(values))}
          className='space-y-4'
          autoComplete='off'
        >
          <FormField
            control={form.control}
            name='password'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('New Password')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type='password'
                    autoComplete='new-password'
                    disabled={reset.isPending}
                  />
                </FormControl>
                <FormDescription>{t('Use 8–128 characters.')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='confirm'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Confirm Password')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type='password'
                    autoComplete='new-password'
                    disabled={reset.isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
    </Dialog>
  )
}
