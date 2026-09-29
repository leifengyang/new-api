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
import { Shield, User, Users } from 'lucide-react'

import type { User as UserType } from './types'

// ============================================================================
// User Utilities
// ============================================================================

export const isUserDeleted = (user: UserType): boolean => {
  return user.DeletedAt != null
}

// ============================================================================
// User Status Configuration
// ============================================================================

export const USER_STATUS = {
  ENABLED: 1,
  DISABLED: 2,
  DELETED: -1,
} as const

export const USER_STATUSES = {
  [USER_STATUS.ENABLED]: {
    labelKey: 'Enabled',
    variant: 'success' as const,
    value: USER_STATUS.ENABLED,
  },
  [USER_STATUS.DISABLED]: {
    labelKey: 'Disabled',
    variant: 'neutral' as const,
    value: USER_STATUS.DISABLED,
  },
  [USER_STATUS.DELETED]: {
    labelKey: 'Deleted',
    variant: 'danger' as const,
    value: USER_STATUS.DELETED,
  },
} as const

export const getUserStatusOptions = (t: (key: string) => string) => [
  { label: t('Enabled'), value: String(USER_STATUS.ENABLED) },
  { label: t('Disabled'), value: String(USER_STATUS.DISABLED) },
  { label: t('Deleted'), value: String(USER_STATUS.DELETED) },
]

// ============================================================================
// User Role Configuration
// ============================================================================

export const USER_ROLE = {
  USER: 1,
  ADMIN: 10,
  ROOT: 100,
} as const

export const USER_ROLES = {
  [USER_ROLE.USER]: {
    labelKey: 'User',
    value: USER_ROLE.USER,
    icon: User,
  },
  [USER_ROLE.ADMIN]: {
    labelKey: 'Admin',
    value: USER_ROLE.ADMIN,
    icon: Users,
  },
  [USER_ROLE.ROOT]: {
    labelKey: 'Root',
    value: USER_ROLE.ROOT,
    icon: Shield,
  },
} as const

export const getUserRoleOptions = (t: (key: string) => string) => [
  { label: t('User'), value: String(USER_ROLE.USER), icon: User },
  { label: t('Admin'), value: String(USER_ROLE.ADMIN), icon: Users },
  { label: t('Root'), value: String(USER_ROLE.ROOT), icon: Shield },
]

/**
 * Mirrors the server rule for deleting an account: you may only delete users
 * strictly below your own role, which also stops anyone from deleting
 * themselves. Used to keep a bulk action from offering a doomed selection.
 */
export const canDeleteUser = (user: UserType, operatorRole: number): boolean =>
  user.role < operatorRole

// ============================================================================
// Member Level Configuration
// ============================================================================
// Internal members are the students invited through an administrator's link.
// They, and only they, earn an invite rebate from the top-ups of the users
// they invite directly.

export const USER_MEMBER_LEVEL = {
  EXTERNAL: 0,
  INTERNAL: 1,
} as const

export const USER_MEMBER_LEVELS = {
  [USER_MEMBER_LEVEL.EXTERNAL]: {
    labelKey: 'External',
    variant: 'neutral' as const,
    value: USER_MEMBER_LEVEL.EXTERNAL,
  },
  [USER_MEMBER_LEVEL.INTERNAL]: {
    labelKey: 'Internal Member',
    variant: 'purple' as const,
    value: USER_MEMBER_LEVEL.INTERNAL,
  },
} as const

export const getUserMemberLevelOptions = (t: (key: string) => string) => [
  {
    label: t('Internal Member'),
    value: String(USER_MEMBER_LEVEL.INTERNAL),
  },
  { label: t('External'), value: String(USER_MEMBER_LEVEL.EXTERNAL) },
]

/** Payloads that omit the level mean the default, which is external. */
export const getUserMemberLevel = (user: UserType): number =>
  user.member_level ?? USER_MEMBER_LEVEL.EXTERNAL

// ============================================================================
// Enterprise Account Flag
// ============================================================================
// 平台管理员给账号打的一个标记，决定这个账号能不能进自己的企业控制台。标记本身
// 不改变角色：被标记的账号仍然是普通用户，打不开任何管理端页面。取消标记时，
// 名下的成员会被移出、余额退回，这一步由服务端完成。

/**
 * 后台用户列表直接序列化 model.User，这一列到前端是 0/1 的整数；而账号自己的
 * /api/user/self 回的是布尔值。两种形态都要认，所以一律走这个判断，别直接比。
 */
export const isEnterpriseAccount = (user: UserType): boolean =>
  user.is_enterprise === true || user.is_enterprise === 1

/**
 * 这个账号是不是某家企业的成员。一个用户只能属于一个企业，而且成员不能再被标记
 * 成企业账号（服务端会拒），所以标记入口对成员不开放。
 */
export const isEnterpriseMember = (user: UserType): boolean =>
  (user.enterprise_owner_id ?? 0) > 0

// ============================================================================
// Rebate Review Configuration
// ============================================================================
// 内部会员的返现要审核通过才能动用：未通过之前，算出来的返现一律以「冻结」的
// 形态记在账上，钱不进余额。审核只影响内部会员——外部账号不参与返现，审核状态
// 对它没有任何作用，所以前台只在内部会员身上展示这枚徽标。
//
// 三种状态里，pending 和 rejected 对钱的效果完全一样：新返现继续冻结，之前冻结
// 的也不放行，区别只在列表上怎么显示。真正放行的只有 approved。

export const REBATE_REVIEW_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const

export type RebateReviewStatus =
  (typeof REBATE_REVIEW_STATUS)[keyof typeof REBATE_REVIEW_STATUS]

export const REBATE_REVIEW_STATUSES = {
  [REBATE_REVIEW_STATUS.PENDING]: {
    labelKey: 'Pending Review',
    variant: 'warning' as const,
  },
  [REBATE_REVIEW_STATUS.APPROVED]: {
    labelKey: 'Approved',
    variant: 'success' as const,
  },
  [REBATE_REVIEW_STATUS.REJECTED]: {
    labelKey: 'Not Approved',
    variant: 'neutral' as const,
  },
} satisfies Record<RebateReviewStatus, { labelKey: string; variant: string }>

export const REBATE_REVIEW_OPTIONS = [
  { value: REBATE_REVIEW_STATUS.PENDING, labelKey: 'Pending Review' },
  { value: REBATE_REVIEW_STATUS.APPROVED, labelKey: 'Approved' },
  { value: REBATE_REVIEW_STATUS.REJECTED, labelKey: 'Not Approved' },
] as const

export const getUserRebateReviewOptions = (t: (key: string) => string) =>
  REBATE_REVIEW_OPTIONS.map(({ value, labelKey }) => ({
    label: t(labelKey),
    value,
  }))

/**
 * 账号当前是不是「已通过」。后端所有账号都带这个字段，外部账号只是拿不到徽标，
 * 判断本身不做身份区分。
 */
export const getRebateReviewStatus = (user: UserType): string =>
  user.rebate_review_status ?? REBATE_REVIEW_STATUS.PENDING

/**
 * 内部会员的返现是不是还压在冻结里。审核状态对非内部会员没有意义，所以这里先看
 * 身份再看状态，避免给外部账号误报「返现冻结中」。
 */
export const isRebateFrozen = (user: UserType): boolean =>
  getUserMemberLevel(user) === USER_MEMBER_LEVEL.INTERNAL &&
  getRebateReviewStatus(user) !== REBATE_REVIEW_STATUS.APPROVED

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_GROUP = 'default' as const

// ============================================================================
// Third-party Binding Fields
// ============================================================================

export const BINDING_FIELDS = [
  { key: 'github_id', label: 'GitHub ID' },
  { key: 'discord_id', label: 'Discord ID' },
  { key: 'oidc_id', label: 'OIDC ID' },
  { key: 'wechat_id', label: 'WeChat ID' },
  { key: 'email', label: 'Email' },
  { key: 'telegram_id', label: 'Telegram ID' },
] as const

// ============================================================================
// Error Messages (i18n keys: use t(ERROR_MESSAGES.xxx) when displaying)
// ============================================================================

export const ERROR_MESSAGES = {
  UNEXPECTED: 'An unexpected error occurred',
  NO_USER: 'No user selected',
  LOAD_FAILED: 'Failed to load users',
  SEARCH_FAILED: 'Failed to search users',
  CREATE_FAILED: 'Failed to create user',
  UPDATE_FAILED: 'Failed to update user',
  DELETE_FAILED: 'Failed to delete user',
} as const

// ============================================================================
// Success Messages (i18n keys: use t(SUCCESS_MESSAGES.xxx) when displaying)
// ============================================================================

export const SUCCESS_MESSAGES = {
  USER_CREATED: 'User created successfully',
  USER_UPDATED: 'User updated successfully',
} as const
