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
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { SectionPageLayout } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

import { CompensationAdmin } from './admin'
import { getCompensationData, useCompensationMutation } from './api'
import { CompensationRecords } from './records'
import {
  drillFilter,
  exportReport,
  initialReportFilter,
  type Aggregate,
  type ReportFilter,
} from './report-api'
import { ReportFilters } from './report-filters'
import { ReportOverview } from './report-overview'
import { ReportTable } from './report-table'

export function CompensationReport() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState(initialReportFilter)
  const [dimensions, setDimensions] = useState(['user'])
  const [drill, setDrill] = useState<ReportFilter | null>(null)
  const mutation = useCompensationMutation()
  const settings = useQuery({
    queryKey: ['stream-compensation', 'admin-settings'],
    queryFn: () => getCompensationData<{ enabled: boolean }>('/admin/settings'),
  })
  const download = useMutation({
    mutationFn: (kind: 'aggregate' | 'records') =>
      exportReport(filter, dimensions, kind),
  })
  const onDrill = (dims: string[], row: Aggregate) =>
    setDrill(drillFilter(filter, dims, row))
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {t('Compensation overview')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <p className='text-muted-foreground mb-4 text-sm'>
          {t(
            'Successfully credited only. Pending items are handled separately.'
          )}
        </p>
        <Tabs defaultValue='overview' className='space-y-4'>
          <TabsList className='max-w-full overflow-x-auto'>
            <TabsTrigger value='overview'>{t('Overview')}</TabsTrigger>
            <TabsTrigger value='records'>
              {t('Compensation ledger')}
            </TabsTrigger>
            <TabsTrigger value='pending'>{t('Pending items')}</TabsTrigger>
            <TabsTrigger value='batches'>{t('Settlement batches')}</TabsTrigger>
          </TabsList>
          <TabsContent value='overview' className='space-y-5'>
            <ReportFilters
              key={`filters:${JSON.stringify(filter)}`}
              value={filter}
              onChange={setFilter}
            />
            <ReportOverview filter={filter} onDrill={onDrill} />
            <ReportTable
              key={`aggregate:${JSON.stringify(filter)}`}
              filter={filter}
              dimensions={dimensions}
              onDimensions={setDimensions}
              onDrill={onDrill}
              onExport={() => download.mutate('aggregate')}
              exporting={download.isPending}
            />
          </TabsContent>
          <TabsContent value='records' className='space-y-4'>
            <ReportFilters
              key={`filters:${JSON.stringify(filter)}`}
              value={filter}
              onChange={setFilter}
            />
            <div className='flex justify-end'>
              <Button
                variant='outline'
                disabled={download.isPending}
                onClick={() => download.mutate('records')}
              >
                {t('Export details CSV')}
              </Button>
            </div>
            <CompensationRecords
              key={`records:${JSON.stringify(filter)}`}
              admin
              reportFilters={filter}
            />
          </TabsContent>
          <TabsContent value='pending' className='space-y-4'>
            <div className='bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4'>
              <p className='text-muted-foreground text-sm'>
                {t('Pending items are excluded from credited totals.')}
              </p>
              <Button
                variant='outline'
                disabled={mutation.isPending || !settings.data?.enabled}
                onClick={() => mutation.mutate({ path: '/admin/run' })}
              >
                {t('Settle / retry now')}
              </Button>
            </div>
            <CompensationRecords admin pendingOnly />
          </TabsContent>
          <TabsContent value='batches'>
            <CompensationAdmin batchesOnly />
          </TabsContent>
        </Tabs>
        <Dialog
          open={drill !== null}
          onOpenChange={(open) => {
            if (!open) setDrill(null)
          }}
          title={t('Compensation ledger')}
          contentClassName='sm:max-w-6xl'
        >
          {drill && (
            <CompensationRecords
              key={JSON.stringify(drill)}
              admin
              reportFilters={drill}
            />
          )}
        </Dialog>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
