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

import type { InviteRebate } from '../types'

type InviteRebatesContextType = {
  /** Row the reverse dialog is acting on; null when the dialog is closed. */
  reversingRow: InviteRebate | null
  setReversingRow: React.Dispatch<React.SetStateAction<InviteRebate | null>>
  refreshTrigger: number
  triggerRefresh: () => void
}

const InviteRebatesContext =
  React.createContext<InviteRebatesContextType | null>(null)

export function InviteRebatesProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [reversingRow, setReversingRow] = useState<InviteRebate | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const triggerRefresh = () => setRefreshTrigger((prev) => prev + 1)

  return (
    <InviteRebatesContext
      value={{ reversingRow, setReversingRow, refreshTrigger, triggerRefresh }}
    >
      {children}
    </InviteRebatesContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useInviteRebates = () => {
  const inviteRebatesContext = React.useContext(InviteRebatesContext)

  if (!inviteRebatesContext) {
    throw new Error(
      'useInviteRebates has to be used within <InviteRebatesProvider>'
    )
  }

  return inviteRebatesContext
}
