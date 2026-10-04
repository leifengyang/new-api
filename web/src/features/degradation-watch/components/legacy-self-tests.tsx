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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

import type { SelfTestResult } from '../lib/self-test'
import { loadSelfTestHistory } from '../lib/storage'
import { ArtworkPlayerDialog } from './artwork-player-dialog'

export function LegacySelfTests() {
  const { t } = useTranslation()
  const [history, setHistory] = useState<SelfTestResult[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<SelfTestResult | null>(null)
  return (
    <details
      className='rounded-xl border p-4'
      onToggle={(event) => {
        setExpanded(event.currentTarget.open)
        if (event.currentTarget.open && history === null) {
          setHistory(loadSelfTestHistory())
        }
      }}
    >
      <summary className='cursor-pointer text-sm'>
        {t('Stored in this browser only')}
      </summary>
      {expanded && (
        <div className='mt-3 flex flex-wrap gap-2'>
          {history?.length === 0 && (
            <EmptyState title={t('No artwork yet')} className='min-h-24' />
          )}
          {history?.map((item) => (
            <Button
              key={item.id}
              variant='outline'
              onClick={() => setSelected(item)}
            >
              {item.model}
            </Button>
          ))}
        </div>
      )}
      {selected && (
        <ArtworkPlayerDialog
          open
          onOpenChange={() => setSelected(null)}
          title={selected.model}
          html={selected.html}
          failureReason={selected.success ? undefined : selected.detail}
          meta={null}
        />
      )}
    </details>
  )
}
