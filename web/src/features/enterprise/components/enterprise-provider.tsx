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
import React, { useState } from 'react'

import type { EnterpriseMember } from '../types'

/**
 * 控制台里会打开的弹窗。每个都能从成员行的操作菜单进入，所以目标成员和弹窗
 * 类型放在同一个上下文里，避免每行各持一份自己的状态。
 */
export type EnterpriseDialogType =
  | 'create-member'
  | 'transfer-quota'
  | 'member-limits'
  | 'reset-password'

type EnterpriseContextType = {
  openDialog: EnterpriseDialogType | null
  setOpenDialog: React.Dispatch<
    React.SetStateAction<EnterpriseDialogType | null>
  >
  /** 当前被操作的成员；关闭弹窗时必须清空，否则下次打开会带着上一次的目标。 */
  activeMember: EnterpriseMember | null
  setActiveMember: React.Dispatch<React.SetStateAction<EnterpriseMember | null>>
  refreshTrigger: number
  triggerRefresh: () => void
}

const EnterpriseContext = React.createContext<EnterpriseContextType | null>(
  null
)

export function EnterpriseProvider(props: { children: React.ReactNode }) {
  const [openDialog, setOpenDialog] = useState<EnterpriseDialogType | null>(
    null
  )
  const [activeMember, setActiveMember] = useState<EnterpriseMember | null>(
    null
  )
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const triggerRefresh = () => setRefreshTrigger((prev) => prev + 1)

  return (
    <EnterpriseContext
      value={{
        openDialog,
        setOpenDialog,
        activeMember,
        setActiveMember,
        refreshTrigger,
        triggerRefresh,
      }}
    >
      {props.children}
    </EnterpriseContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useEnterprise = () => {
  const context = React.useContext(EnterpriseContext)

  if (!context) {
    throw new Error('useEnterprise has to be used within <EnterpriseProvider>')
  }

  return context
}
