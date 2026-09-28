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

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useIsAdmin } from '@/hooks/use-admin'
import { toIntlLocale } from '@/i18n/languages'
import { formatTimestampRelative } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import { getDegradationWatchRecords } from '../api'
import { successRate } from '../lib/artwork'
import { mergeRecords, WALL_PAGE_SIZE } from '../lib/records'
import type { DegradationWatchRecord, DegradationWatchSection } from '../types'
import { RecordPlayerDialog } from './artwork-player-dialog'
import { RecordCard } from './record-card'

interface WallSectionProps {
  section: DegradationWatchSection
}

export function WallSection(props: WallSectionProps) {
  const { t, i18n } = useTranslation()
  const isAdmin = useIsAdmin()
  const section = props.section
  const [older, setOlder] = useState<DegradationWatchRecord[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [openRecord, setOpenRecord] = useState<DegradationWatchRecord | null>(
    null
  )

  const records = mergeRecords(section.records, older)
  const rate = successRate(section.succeeded, section.total)
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const rateText =
    rate === null
      ? '-'
      : new Intl.NumberFormat(locale, {
          style: 'percent',
          maximumFractionDigits: 1,
        }).format(rate)
  // Admins page through hidden records too; everyone else only sees visible ones.
  const available = isAdmin ? section.total : section.visible
  const canLoadMore =
    !exhausted && records.length > 0 && records.length < available

  async function loadMore() {
    const last = records.at(-1)
    if (!last) return
    setLoadingMore(true)
    try {
      const result = await getDegradationWatchRecords(last.id, WALL_PAGE_SIZE)
      if (!result.success || !result.data) {
        throw createServerError(result, t('Failed to load more artwork'))
      }
      const page = result.data
      setOlder((current) => [...current, ...page])
      if (page.length < WALL_PAGE_SIZE) setExhausted(true)
    } catch (error) {
      handleServerError(error, t('Failed to load more artwork'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-end justify-between gap-2'>
        <div className='flex min-w-0 flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <h2 className='truncate text-lg font-semibold'>{section.title}</h2>
            {!section.aliased && (
              <Badge variant='outline'>{t('Not on the public wall')}</Badge>
            )}
          </div>
          <p className='text-muted-foreground text-sm'>
            {t('{{count}} artworks shown', { count: section.visible })}
            {' · '}
            {t('Updated {{time}}', {
              time: formatTimestampRelative(
                section.last_record_at,
                'seconds',
                locale
              ),
            })}
          </p>
        </div>
        <div className='text-right text-sm'>
          <div className='text-muted-foreground'>
            {t('Runs')}{' '}
            <span className='text-foreground font-medium tabular-nums'>
              {section.succeeded}/{section.total}
            </span>
          </div>
          <div className='text-muted-foreground'>
            {t('Success rate')}{' '}
            <span className='text-foreground font-medium tabular-nums'>
              {rateText}
            </span>
          </div>
        </div>
      </div>

      {records.length === 0 ? (
        <p className='text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm'>
          {t('No artwork to show yet')}
        </p>
      ) : (
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'>
          {records.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              onOpen={setOpenRecord}
            />
          ))}
        </div>
      )}

      {canLoadMore && (
        <div className='flex justify-center'>
          <Button
            variant='outline'
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? t('Loading...') : t('Load more')}
          </Button>
        </div>
      )}

      <RecordPlayerDialog
        title={section.title}
        record={openRecord}
        onClose={() => setOpenRecord(null)}
      />
    </section>
  )
}
