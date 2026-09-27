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
/** 与后端 common.UserStatusEnabled / UserStatusDisabled 对齐。 */
export const ENTERPRISE_MEMBER_STATUS = {
  ENABLED: 1,
  DISABLED: 2,
} as const

export const ENTERPRISE_MEMBER_STATUSES = {
  [ENTERPRISE_MEMBER_STATUS.ENABLED]: {
    labelKey: 'Enabled',
    variant: 'success' as const,
  },
  [ENTERPRISE_MEMBER_STATUS.DISABLED]: {
    labelKey: 'Disabled',
    variant: 'neutral' as const,
  },
} as const

export const getEnterpriseMemberStatusOptions = (
  t: (key: string) => string
) => [
  { label: t('Enabled'), value: String(ENTERPRISE_MEMBER_STATUS.ENABLED) },
  { label: t('Disabled'), value: String(ENTERPRISE_MEMBER_STATUS.DISABLED) },
]

// 与 model.User 上的校验标签一一对应（username max=20、password 8~128、
// display_name max=20、remark max=255），前端先挡一道，服务端仍会再校一遍。
// 密码那一档（8~128）不在这里写第二份：用 lib/password-policy 的
// accountPasswordSchema，它按码点计数，与服务端的 rune 口径一致。
export const MEMBER_USERNAME_MAX_LENGTH = 20
export const MEMBER_DISPLAY_NAME_MAX_LENGTH = 20
export const MEMBER_REMARK_MAX_LENGTH = 255

// ============================================================================
// Error Messages（i18n 键：展示时必须 t(ERROR_MESSAGES.xxx)）
// ============================================================================

export const ERROR_MESSAGES = {
  UNEXPECTED: 'An unexpected error occurred',
  LOAD_PROFILE_FAILED: 'Failed to load the enterprise account',
  LOAD_MEMBERS_FAILED: 'Failed to load members',
  CREATE_MEMBER_FAILED: 'Failed to create the member',
  UPDATE_STATUS_FAILED: 'Failed to update the member status',
  UPDATE_LIMITS_FAILED: 'Failed to save the visible range',
  TRANSFER_QUOTA_FAILED: 'Failed to transfer quota',
  RESET_PASSWORD_FAILED: 'Failed to reset the password',
  LOAD_USAGE_FAILED: 'Failed to load usage',
  LOAD_LOGS_FAILED: 'Failed to load logs',
} as const
