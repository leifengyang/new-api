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
import { useQuery } from '@tanstack/react-query'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePagination, StaticDataTable } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { getCompensationData, type Page } from './api'
import {
  aggregateLabel,
  dimensionLabels,
  fundingLabels,
  type Aggregate,
  type ReportFilter,
} from './report-api'

export function ReportTable(props: {
  filter: ReportFilter
  dimensions: string[]
  onDimensions: (dimensions: string[]) => void
  onDrill: (dimensions: string[], row: Aggregate) => void
  onExport: () => void
  exporting: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const [invalid, setInvalid] = useState(false)
  const query = useQuery({
    queryKey: [
      'stream-compensation',
      'aggregate',
      props.filter,
      props.dimensions,
      pagination,
    ],
    queryFn: () =>
      getCompensationData<Page<Aggregate>>('/admin/report/aggregate', {
        ...props.filter,
        dimensions: props.dimensions.join(','),
        p: pagination.pageIndex + 1,
        page_size: pagination.pageSize,
      }),
    refetchInterval: 30_000,
  })
  const table = useReactTable({
    data: query.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: query.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  const change = (values: string[]) => {
    const invalid = values.length < 1 || values.length > 3
    setInvalid(invalid)
    if (!invalid) {
      setPagination({ ...pagination, pageIndex: 0 })
      props.onDimensions(values)
    }
  }
  return (
    <section className='space-y-4 rounded-xl border p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h2 className='font-semibold'>{t('Aggregate analysis')}</h2>
        <Button
          variant='outline'
          disabled={props.exporting}
          onClick={props.onExport}
        >
          {t('Export summary CSV')}
        </Button>
      </div>
      <div className='flex flex-wrap gap-2'>
        {Object.entries(dimensionLabels).map(([key, label]) => (
          <Button
            key={key}
            size='sm'
            variant={
              props.dimensions.length === 1 && props.dimensions[0] === key
                ? 'secondary'
                : 'ghost'
            }
            onClick={() => change([key])}
          >
            {t(label)}
          </Button>
        ))}
      </div>
      <div className='max-w-xl space-y-2'>
        <Label htmlFor='report-dimensions'>
          {t('Combine up to 3 dimensions')}
        </Label>
        <MultiSelect
          id='report-dimensions'
          options={Object.entries(dimensionLabels).map(([value, label]) => ({
            value,
            label: t(label),
          }))}
          selected={props.dimensions}
          onChange={change}
        />
        {invalid && (
          <p role='alert' className='text-destructive text-sm'>
            {t('Select 1 to 3 dimensions')}
          </p>
        )}
      </div>
      {query.isPending && <LoadingState />}
      {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
      {query.isSuccess && (
        <>
          <StaticDataTable
            data={query.data.items}
            getRowKey={(r) => JSON.stringify([r.d0, r.d1, r.d2])}
            emptyContent={t('No compensation records')}
            columns={[
              ...props.dimensions.map((dimension, index) => ({
                id: dimension,
                header: t(dimensionLabels[dimension]),
                cell: (row: Aggregate) => {
                  const value = [row.d0, row.d1, row.d2][index]
                  let label = aggregateLabel(
                    dimension,
                    value,
                    [row.l0, row.l1, row.l2][index],
                    t('Unknown')
                  )
                  if (dimension === 'funding') {
                    label = t(fundingLabels[value] || 'Unknown')
                  }
                  if (dimension === 'reason' && value === 'abnormal_eof') {
                    label = t('Abnormal EOF')
                  }
                  return (
                    <span className='block max-w-64 truncate' title={label}>
                      {label}
                    </span>
                  )
                },
              })),
              {
                id: 'quota',
                header: t('Stream credits'),
                cell: (r) => (
                  <span className='font-semibold text-emerald-600 dark:text-emerald-400'>
                    {formatQuotaWithCurrency(r.quota, {
                      digitsSmall: 6,
                      digitsLarge: 6,
                    })}
                  </span>
                ),
              },
              {
                id: 'count',
                header: t('Compensated requests'),
                cell: (r) => formatNumber(r.count, locale),
              },
              {
                id: 'users',
                header: t('Affected users'),
                cell: (r) => formatNumber(r.users, locale),
              },
              {
                id: 'details',
                header: t('Actions'),
                cell: (r) => (
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => props.onDrill(props.dimensions, r)}
                  >
                    {t('Details')}
                  </Button>
                ),
              },
            ]}
          />
          <DataTablePagination table={table} />
        </>
      )}
    </section>
  )
}
