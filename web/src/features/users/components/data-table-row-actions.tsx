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
import type { Row } from '@tanstack/react-table'
import {
  Pencil,
  Trash2,
  Power,
  PowerOff,
  ArrowUp,
  ArrowDown,
  KeyRound,
  ShieldAlert,
  Link2,
  CreditCard,
  GraduationCap,
  UserRoundMinus,
  Building,
  Building2,
  ClipboardCheck,
  CircleCheck,
  CircleSlash,
  CircleDashed,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTableRowActionMenu } from '@/components/data-table/core/row-action-menu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import { updateEnterpriseMemberStatus } from '@/features/enterprise/api'
import { UserSubscriptionsDialog } from '@/features/subscriptions/components/dialogs/user-subscriptions-dialog'
import { handleServerError } from '@/lib/handle-server-error'

import {
  manageUser,
  resetUserPasskey,
  resetUserTwoFA,
  updateUserEnterprise,
  updateUserMemberLevel,
  updateUserRebateReview,
} from '../api'
import {
  USER_STATUS,
  USER_ROLE,
  USER_MEMBER_LEVEL,
  REBATE_REVIEW_STATUS,
  ERROR_MESSAGES,
  getRebateReviewStatus,
  getUserMemberLevel,
  isEnterpriseAccount,
  isEnterpriseMember,
  isUserDeleted,
} from '../constants'
import { getUserActionMessage } from '../lib'
import type { User, ManageUserAction } from '../types'
import { EnterpriseWalletDialog } from './dialogs/enterprise-wallet-dialog'
import { UserBindingDialog } from './dialogs/user-binding-dialog'
import { useUsers } from './users-provider'

interface DataTableRowActionsProps {
  row: Row<User>
}

/**
 * 三种审核结果各自的成功提示。未通过和未审核对钱的效果一样——都继续冻结——所以
 * 文案只讲状态变了，不提钱；真正的放行只发生在 approved 且确实有冻结行的时候。
 */
const REBATE_REVIEW_MESSAGES: Record<string, string> = {
  [REBATE_REVIEW_STATUS.APPROVED]:
    'Approved the rebate review for {{username}}',
  [REBATE_REVIEW_STATUS.REJECTED]: 'Set {{username}} to not approved',
  [REBATE_REVIEW_STATUS.PENDING]: 'Set {{username}} back to pending review',
}

/** 「审核」子菜单里的三项，顺序就是从严到宽再回到未审核。 */
const REBATE_REVIEW_MENU_ITEMS = [
  {
    status: REBATE_REVIEW_STATUS.APPROVED,
    labelKey: 'Approve',
    icon: CircleCheck,
  },
  {
    status: REBATE_REVIEW_STATUS.REJECTED,
    labelKey: 'Not Approved',
    icon: CircleSlash,
  },
  {
    status: REBATE_REVIEW_STATUS.PENDING,
    labelKey: 'Pending Review',
    icon: CircleDashed,
  },
] as const

export function DataTableRowActions({ row }: DataTableRowActionsProps) {
  const { t } = useTranslation()
  const verification = useSecureVerification()
  const [walletOpen, setWalletOpen] = useState(false)
  const user = row.original
  const { setOpen, setCurrentRow, triggerRefresh } = useUsers()
  const [resetPasskeyOpen, setResetPasskeyOpen] = useState(false)
  const [resetTwoFAOpen, setResetTwoFAOpen] = useState(false)
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false)
  const [subscriptionsDialogOpen, setSubscriptionsDialogOpen] = useState(false)
  const [memberLevelTarget, setMemberLevelTarget] = useState<number | null>(
    null
  )
  const [memberLevelPending, setMemberLevelPending] = useState(false)
  // 标记 / 取消企业账号，走的是和会员等级同一套「先确认再执行」的流程：
  // 取消标记会把名下成员全部移出并把余额退回，值得先问一句。
  const [enterpriseTarget, setEnterpriseTarget] = useState<boolean | null>(null)
  const [enterprisePending, setEnterprisePending] = useState(false)
  // 返现审核。改成 approved 会把该账号名下所有冻结的返现一次性放行，是一个动钱
  // 的动作，所以跟企业标记一样先弹确认再执行。
  const [rebateReviewTarget, setRebateReviewTarget] = useState<string | null>(
    null
  )
  const [rebateReviewPending, setRebateReviewPending] = useState(false)

  const handleEdit = () => {
    setCurrentRow(user)
    setOpen('update')
  }

  const handleDelete = () => {
    setCurrentRow(user)
    setOpen('delete')
  }

  const handleManage = async (action: Exclude<ManageUserAction, 'delete'>) => {
    try {
      let result
      if (
        isEnterpriseMember(user) &&
        (action === 'enable' || action === 'disable')
      ) {
        const proof = await verification.requestVerification({
          scope: 'enterprise.member.manage',
          context: { member_id: user.id, action },
          title: t('Verify your identity'),
        })
        if (!proof) return
        result = await updateEnterpriseMemberStatus(
          user.id,
          action === 'enable',
          proof.proof_token,
          true
        )
      } else {
        result = await manageUser(user.id, action)
      }
      if (result.success) {
        toast.success(t(getUserActionMessage(action)))
        triggerRefresh()
      } else {
        handleServerError(result, t('Failed to {{action}} user', { action }))
      }
    } catch (error) {
      handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
    }
  }

  const handleResetPasskey = async () => {
    try {
      const result = await resetUserPasskey(user.id)
      if (result.success) {
        toast.success(t('Passkey reset successfully'))
        triggerRefresh()
      } else {
        handleServerError(result, t('Failed to reset Passkey'))
      }
    } catch (error) {
      handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
    } finally {
      setResetPasskeyOpen(false)
    }
  }

  const handleResetTwoFA = async () => {
    try {
      const result = await resetUserTwoFA(user.id)
      if (result.success) {
        toast.success(t('Two-factor authentication reset'))
        triggerRefresh()
      } else {
        handleServerError(result, t('Failed to reset 2FA'))
      }
    } catch (error) {
      handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
    } finally {
      setResetTwoFAOpen(false)
    }
  }

  const handleMemberLevel = async (level: number) => {
    setMemberLevelPending(true)
    try {
      const result = await updateUserMemberLevel(user.id, level)
      if (result.success) {
        toast.success(
          level === USER_MEMBER_LEVEL.INTERNAL
            ? t('Marked {{username}} as an internal member', {
                username: user.username,
              })
            : t('Marked {{username}} as an external user', {
                username: user.username,
              })
        )
        triggerRefresh()
      } else {
        handleServerError(result, t('Failed to update the member level'))
      }
    } catch (error) {
      handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
    } finally {
      setMemberLevelPending(false)
      setMemberLevelTarget(null)
    }
  }

  const handleEnterprise = async (isEnterprise: boolean) => {
    setEnterprisePending(true)
    try {
      const result = await updateUserEnterprise(user.id, isEnterprise)
      if (result.success) {
        const released = result.data?.released_members ?? 0
        if (isEnterprise) {
          toast.success(
            t('Marked {{username}} as an enterprise account', {
              username: user.username,
            })
          )
        } else if (released > 0) {
          toast.success(
            t(
              'Cancelled the enterprise account for {{username}} and released {{count}} members',
              { username: user.username, count: released }
            )
          )
        } else {
          toast.success(
            t('Cancelled the enterprise account for {{username}}', {
              username: user.username,
            })
          )
        }
        triggerRefresh()
      } else {
        handleServerError(result, t('Failed to update the enterprise account'))
      }
    } catch (error) {
      handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
    } finally {
      setEnterprisePending(false)
      setEnterpriseTarget(null)
    }
  }

  const handleRebateReview = async (status: string) => {
    setRebateReviewPending(true)
    try {
      const result = await updateUserRebateReview(user.id, status)
      if (result.success) {
        // 服务端回来的 data 是这一次真正放行的返现行数。通过审核时顺带说出来，
        // 管理员才知道刚才那一下到底动没动钱。
        const released = result.data ?? 0
        if (status === REBATE_REVIEW_STATUS.APPROVED && released > 0) {
          toast.success(
            t(
              'Approved the rebate review for {{username}} and released {{count}} rebates',
              { username: user.username, count: released }
            )
          )
        } else {
          toast.success(
            t(REBATE_REVIEW_MESSAGES[status] ?? 'Rebate review updated', {
              username: user.username,
            })
          )
        }
        triggerRefresh()
      } else {
        handleServerError(result, t('Failed to update the rebate review'))
      }
    } catch (error) {
      handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
    } finally {
      setRebateReviewPending(false)
      setRebateReviewTarget(null)
    }
  }

  const isDisabled = user.status === USER_STATUS.DISABLED
  const isAdmin = user.role >= USER_ROLE.ADMIN
  const isRoot = user.role === USER_ROLE.ROOT
  const isInternalMember =
    getUserMemberLevel(user) === USER_MEMBER_LEVEL.INTERNAL
  const currentRebateReviewStatus = getRebateReviewStatus(user)
  const isEnterprise = isEnterpriseAccount(user)
  // 只有普通用户可以当企业账号（服务端同样只放普通用户），成员也不能再被标记，
  // 所以这两种账号上干脆不显示这个入口。
  const canToggleEnterprise =
    isEnterprise || (!isAdmin && !isEnterpriseMember(user))

  if (isUserDeleted(user)) {
    return null
  }

  return (
    <div className='-ml-1.5 flex items-center gap-1'>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant='ghost'
              size='icon-sm'
              onClick={handleEdit}
              aria-label={t('Edit')}
            />
          }
        >
          <Pencil />
        </TooltipTrigger>
        <TooltipContent>{t('Edit')}</TooltipContent>
      </Tooltip>

      <DataTableRowActionMenu
        ariaLabel={t('Open menu')}
        contentClassName='w-48'
      >
        {isDisabled ? (
          <DropdownMenuItem onClick={() => handleManage('enable')}>
            {t('Enable')}
            <DropdownMenuShortcut>
              <Power size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={() => handleManage('disable')}
            disabled={isRoot}
          >
            {t('Disable')}
            <DropdownMenuShortcut>
              <PowerOff size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}

        {isAdmin && !isRoot && (
          <DropdownMenuItem onClick={() => handleManage('demote')}>
            {t('Demote')}
            <DropdownMenuShortcut>
              <ArrowDown size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}

        {!isAdmin && (
          <DropdownMenuItem
            disabled={isEnterpriseMember(user) || isEnterprise}
            onClick={() => handleManage('promote')}
          >
            {t('Promote')}
            <DropdownMenuShortcut>
              <ArrowUp size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}

        {/* Internal members earn a rebate on every top-up of the users they
            invited, external users only on an invitee's first one, so this is
            how a user is moved between the two. */}
        {isInternalMember ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setMemberLevelTarget(USER_MEMBER_LEVEL.EXTERNAL)
            }}
          >
            {t('Mark as external user')}
            <DropdownMenuShortcut>
              <UserRoundMinus size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setMemberLevelTarget(USER_MEMBER_LEVEL.INTERNAL)
            }}
          >
            {t('Mark as internal member')}
            <DropdownMenuShortcut>
              <GraduationCap size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}

        {/* 返现审核入口。只有内部会员有返现可审——外部账号不参与返现，审核状态
            对它没有任何作用，所以这一类账号上不显示这一项。 */}
        {isInternalMember && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t('Review')}
              <DropdownMenuShortcut>
                <ClipboardCheck size={16} />
              </DropdownMenuShortcut>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className='w-48'>
              {REBATE_REVIEW_MENU_ITEMS.map((item) => (
                <DropdownMenuItem
                  key={item.status}
                  // 当前状态那一项留在菜单里但点不动：它同时也是「现在是哪一个」
                  // 的提示，比把当前项藏起来更好认。
                  disabled={currentRebateReviewStatus === item.status}
                  onSelect={(event) => {
                    event.preventDefault()
                    setRebateReviewTarget(item.status)
                  }}
                >
                  {t(item.labelKey)}
                  <DropdownMenuShortcut>
                    <item.icon size={16} />
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {(isEnterpriseMember(user) ||
          (user.enterprise_frozen_quota ?? 0) > 0) && (
          <DropdownMenuItem onSelect={() => setWalletOpen(true)}>
            {t('Enterprise balance management')}
          </DropdownMenuItem>
        )}
        {canToggleEnterprise &&
          (isEnterprise ? (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setEnterpriseTarget(false)
              }}
            >
              {t('Cancel enterprise account')}
              <DropdownMenuShortcut>
                <Building size={16} />
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setEnterpriseTarget(true)
              }}
            >
              {t('Mark as enterprise account')}
              <DropdownMenuShortcut>
                <Building2 size={16} />
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setBindingDialogOpen(true)
          }}
        >
          {t('Manage Bindings')}
          <DropdownMenuShortcut>
            <Link2 size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setSubscriptionsDialogOpen(true)
          }}
        >
          {t('Manage Subscriptions')}
          <DropdownMenuShortcut>
            <CreditCard size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setResetPasskeyOpen(true)
          }}
          disabled={isRoot}
        >
          {t('Reset Passkey')}
          <DropdownMenuShortcut>
            <KeyRound size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setResetTwoFAOpen(true)
          }}
          disabled={isRoot}
        >
          {t('Reset 2FA')}
          <DropdownMenuShortcut>
            <ShieldAlert size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={handleDelete}
          className='text-destructive focus:text-destructive'
          disabled={isRoot}
        >
          {t('Delete')}
          <DropdownMenuShortcut>
            <Trash2 size={16} />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </DataTableRowActionMenu>

      <ConfirmDialog
        open={resetPasskeyOpen}
        onOpenChange={setResetPasskeyOpen}
        title={t('Reset Passkey')}
        desc={t(
          'Reset Passkey for {{username}}? The user will need to register a new Passkey before using passwordless login.',
          { username: user.username }
        )}
        confirmText={t('Reset Passkey')}
        handleConfirm={handleResetPasskey}
      />

      <ConfirmDialog
        open={memberLevelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMemberLevelTarget(null)
        }}
        title={
          memberLevelTarget === USER_MEMBER_LEVEL.INTERNAL
            ? t('Mark {{username}} as an internal member?', {
                username: user.username,
              })
            : t('Mark {{username}} as an external user?', {
                username: user.username,
              })
        }
        desc={
          memberLevelTarget === USER_MEMBER_LEVEL.INTERNAL
            ? t(
                'They earn an invite rebate from the top-ups of the users they invite directly, plus a share of the top-ups made by the users those invitees bring in.'
              )
            : t(
                'They keep earning an invite rebate from the top-ups of the users they invite directly, at the external rate, and the first internal member above them also earns from those top-ups. Rebates already credited are not reversed.'
              )
        }
        confirmText={memberLevelPending ? t('Saving...') : t('Confirm')}
        isLoading={memberLevelPending}
        handleConfirm={() => {
          if (memberLevelTarget !== null && !memberLevelPending) {
            void handleMemberLevel(memberLevelTarget)
          }
        }}
      />

      <ConfirmDialog
        open={rebateReviewTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRebateReviewTarget(null)
        }}
        title={
          rebateReviewTarget === REBATE_REVIEW_STATUS.APPROVED
            ? t('Approve the rebate review for {{username}}?', {
                username: user.username,
              })
            : t('Change the rebate review for {{username}}?', {
                username: user.username,
              })
        }
        desc={
          rebateReviewTarget === REBATE_REVIEW_STATUS.APPROVED
            ? t(
                'Every frozen rebate this member has earned is credited to their balance right away. Their wallet has a ceiling: any rebate that would go past it is left recorded but not credited, and the rest are still released.'
              )
            : t(
                'Their rebates stay frozen and nothing is credited. Rebates already credited are not taken back — use the ledger reversal if you need to claw one back.'
              )
        }
        confirmText={rebateReviewPending ? t('Saving...') : t('Confirm')}
        isLoading={rebateReviewPending}
        handleConfirm={() => {
          if (rebateReviewTarget !== null && !rebateReviewPending) {
            void handleRebateReview(rebateReviewTarget)
          }
        }}
      />

      <ConfirmDialog
        open={enterpriseTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEnterpriseTarget(null)
        }}
        title={
          enterpriseTarget
            ? t('Mark {{username}} as an enterprise account?', {
                username: user.username,
              })
            : t('Cancel the enterprise account for {{username}}?', {
                username: user.username,
              })
        }
        desc={
          enterpriseTarget
            ? t(
                'They keep their role: this only opens an enterprise console where they can create members, hand out quota from their own balance, and narrow what each member can use. Members are ordinary platform accounts that administrators still see and manage.'
              )
            : t(
                'Remove all members before cancelling this enterprise account. Its balance is retained.'
              )
        }
        // 「取消企业账号」里的「取消」是取消这个标记，不是取消对话框；确认按钮
        // 沿用同一个词容易看错，所以两处都只说 Confirm，由标题说明要做什么。
        confirmText={enterprisePending ? t('Saving...') : t('Confirm')}
        destructive={enterpriseTarget === false}
        isLoading={enterprisePending}
        handleConfirm={() => {
          if (enterpriseTarget !== null && !enterprisePending) {
            void handleEnterprise(enterpriseTarget)
          }
        }}
      />

      <ConfirmDialog
        open={resetTwoFAOpen}
        onOpenChange={setResetTwoFAOpen}
        title={t('Reset Two-Factor Authentication')}
        desc={t(
          'Reset 2FA for {{username}}? The user must set up 2FA again to continue using it.',
          { username: user.username }
        )}
        confirmText={t('Reset 2FA')}
        handleConfirm={handleResetTwoFA}
      />

      <UserBindingDialog
        open={bindingDialogOpen}
        onOpenChange={setBindingDialogOpen}
        userId={user.id}
        onUnbindSuccess={triggerRefresh}
      />

      <UserSubscriptionsDialog
        open={subscriptionsDialogOpen}
        onOpenChange={setSubscriptionsDialogOpen}
        user={{ id: user.id, username: user.username }}
        onSuccess={triggerRefresh}
      />
      <EnterpriseWalletDialog
        user={user}
        open={walletOpen}
        onOpenChange={setWalletOpen}
        onSuccess={triggerRefresh}
      />
      <SecureVerificationDialog {...verification.dialogProps} />
    </div>
  )
}
