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
import { useTranslation } from 'react-i18next'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

import { CompensationInbox } from './messages'
import { CompensationRecords } from './records'

export function WalletCompensation() {
  const { t } = useTranslation()
  return (
    <section
      id='stream-compensation'
      className='space-y-4 rounded-xl border p-4 sm:p-6'
    >
      <h2 className='font-semibold'>{t('Stream compensation')}</h2>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Eligible interrupted requests are credited to your personal balance daily. Original charges remain available for reconciliation.'
        )}
      </p>
      <Tabs defaultValue='records'>
        <TabsList>
          <TabsTrigger value='records'>{t('Compensation ledger')}</TabsTrigger>
          <TabsTrigger value='inbox'>{t('Compensation inbox')}</TabsTrigger>
        </TabsList>
        <TabsContent value='records' className='pt-4'>
          <CompensationRecords />
        </TabsContent>
        <TabsContent value='inbox' className='pt-4'>
          <CompensationInbox />
        </TabsContent>
      </Tabs>
    </section>
  )
}
