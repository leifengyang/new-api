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
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { CopyButton } from '@/components/copy-button'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { generateAffiliateLink } from '@/features/wallet/lib'
import { handleServerError } from '@/lib/handle-server-error'
import { accountPasswordSchema } from '@/lib/password-policy'
import { createServerError } from '@/lib/server-error-message'

import { createEnterpriseMember } from '../../api'
import {
  ERROR_MESSAGES,
  MEMBER_DISPLAY_NAME_MAX_LENGTH,
  MEMBER_REMARK_MAX_LENGTH,
  MEMBER_USERNAME_MAX_LENGTH,
} from '../../constants'
import { useEnterprise } from '../enterprise-provider'

// 校验规则照着服务端的标签写（username <=20、password 8~128、display_name
// <=20、remark <=255）。重名、名额上限这些只有服务端知道，交给它返回。
// 密码用 accountPasswordSchema：它按码点计数，和服务端的 rune 口径一致。
const schema = z.object({
  username: z
    .string()
    .trim()
    .min(1, 'Please enter your username')
    .max(MEMBER_USERNAME_MAX_LENGTH),
  password: accountPasswordSchema,
  display_name: z.string().trim().max(MEMBER_DISPLAY_NAME_MAX_LENGTH),
  remark: z.string().trim().max(MEMBER_REMARK_MAX_LENGTH),
})

type Values = z.infer<typeof schema>

const DIRECT = 'direct'
const INVITE = 'invite'

interface CreateMemberDialogProps {
  /** 企业账号的推广码，同时就是成员邀请码。 */
  inviteCode: string
}

export function CreateMemberDialog(props: CreateMemberDialogProps) {
  const { t } = useTranslation()
  const { openDialog, setOpenDialog, triggerRefresh } = useEnterprise()
  const [mode, setMode] = useState<string>(DIRECT)

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '', display_name: '', remark: '' },
  })

  const open = openDialog === 'create-member'

  const create = useMutation({
    mutationFn: async (values: Values) => {
      const result = await createEnterpriseMember({
        username: values.username,
        password: values.password,
        display_name: values.display_name,
        remark: values.remark,
      })
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: (result) => {
      toast.success(
        t(
          '{{username}} was created. Tell them the initial password so they can sign in.',
          { username: result.data?.username ?? '' }
        )
      )
      close()
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t(ERROR_MESSAGES.CREATE_MEMBER_FAILED))
    },
  })

  function close() {
    form.reset()
    setMode(DIRECT)
    setOpenDialog(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && !create.isPending) close()
  }

  // 邀请链接走的是企业推广码：带着它注册的新用户直接落到本企业名下，
  // 与企业账号之间不建立邀请返现关系（见服务端注册准入）。
  const inviteLink = props.inviteCode
    ? generateAffiliateLink(props.inviteCode)
    : ''

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('Add Member')}
      description={t(
        'Create the account here and pass on the initial password, or send an invite link and let the member set their own password.'
      )}
      contentClassName='sm:max-w-md'
      bodyClassName='space-y-4'
      footer={
        mode === INVITE ? (
          <Button variant='outline' onClick={close}>
            {t('Close')}
          </Button>
        ) : (
          <>
            <Button
              type='button'
              variant='outline'
              onClick={close}
              disabled={create.isPending}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='submit'
              form='enterprise-create-member-form'
              disabled={create.isPending}
            >
              {create.isPending ? (
                <Loader2 className='size-4 animate-spin' />
              ) : null}
              {create.isPending ? t('Creating...') : t('Create')}
            </Button>
          </>
        )
      }
    >
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList className='w-full'>
          <TabsTrigger value={DIRECT} className='flex-1'>
            {t('Create an account')}
          </TabsTrigger>
          <TabsTrigger value={INVITE} className='flex-1'>
            {t('Invite link')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value={DIRECT} className='pt-2'>
          <Form {...form}>
            <form
              id='enterprise-create-member-form'
              onSubmit={form.handleSubmit((values) => create.mutate(values))}
              className='space-y-4'
              autoComplete='off'
            >
              <FormField
                control={form.control}
                name='username'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Username')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete='off'
                        disabled={create.isPending}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('At most {{count}} characters.', {
                        count: MEMBER_USERNAME_MAX_LENGTH,
                      })}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='password'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Password')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type='password'
                        autoComplete='new-password'
                        disabled={create.isPending}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('Use 8–128 characters.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='display_name'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Display Name')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete='off'
                        disabled={create.isPending}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('Leave empty to use the username.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='remark'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Remark')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete='off'
                        disabled={create.isPending}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        </TabsContent>

        <TabsContent value={INVITE} className='space-y-2 pt-2'>
          <div className='flex items-center gap-2'>
            <Input
              value={inviteLink}
              readOnly
              aria-label={t('Invite link')}
              className='border-muted bg-background/70 h-9 min-w-0 flex-1 font-mono text-xs'
            />
            {inviteLink ? (
              <CopyButton
                value={inviteLink}
                variant='outline'
                className='bg-background size-9 shrink-0'
                iconClassName='size-4'
                tooltip={t('Copy invite link')}
                aria-label={t('Copy invite link')}
              />
            ) : null}
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Users who register through this link join this enterprise automatically. They do not receive the platform welcome quota, so hand them quota from this balance before they can call the API.'
            )}
          </p>
        </TabsContent>
      </Tabs>
    </Dialog>
  )
}
