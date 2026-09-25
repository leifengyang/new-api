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
import type { SystemStatus } from '../types'
import { getAffiliateCode } from './storage'

/**
 * Whether this visit carries an invitation credential.
 *
 * Two sources count: the affiliate code an earlier invitation link persisted,
 * and the `aff` parameter on the current address. The second source is read
 * directly because the root provider persists it only after mount, so a visitor
 * opening an invitation link must not be judged before that effect runs.
 */
export function hasInvitationCredential(): boolean {
  if (getAffiliateCode()) return true
  if (typeof window === 'undefined') return false
  return Boolean(new URLSearchParams(window.location.search).get('aff')?.trim())
}

/**
 * Whether the registration interface may be shown to this visit.
 *
 * 仅邀请注册关闭时一律放行。开启时必须携带邀请凭证，否则不渲染注册界面（含第三方
 * 注册入口），只显示未对外开放的说明。这一层只决定渲染哪一屏：邀请码是否有效由
 * 服务端在校验注册请求时独立裁定，前端判断不构成准入依据。
 */
export function isRegistrationOpen(
  status: SystemStatus | null | undefined
): boolean {
  if (status?.invite_only_registration_enabled !== true) return true
  return hasInvitationCredential()
}
