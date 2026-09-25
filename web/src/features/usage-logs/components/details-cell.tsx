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
import { ViewIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { UsageLog } from '../data/schema'
import { DetailsDialog } from './dialogs/details-dialog'

/**
 * The entry point the logs table shows in place of the old inline billing
 * summary, and the owner of the dialog's open state. It lives in its own module
 * so its identity is stable: declared inline in the column definition it would
 * be a new component type every time the column memo recomputes — which its `t`
 * and `currency` dependencies make routine — and React would remount the cell,
 * closing a dialog the reader has open.
 */
export function DetailsCell(props: {
  log: UsageLog
  isAdmin: boolean
  isRoot: boolean
}) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <button
        type='button'
        className='text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline'
        onClick={() => setDialogOpen(true)}
        title={t('Click to view full details')}
      >
        <HugeiconsIcon
          icon={ViewIcon}
          className='size-3'
          strokeWidth={2}
          aria-hidden='true'
        />
        {t('View details')}
      </button>
      <DetailsDialog
        log={props.log}
        isAdmin={props.isAdmin}
        isRoot={props.isRoot}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  )
}
