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
import { Bird } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { useDegradationWatchWall } from '../hooks/use-degradation-watch'
import { WallSection } from './wall-section'

export function WatchWall() {
  const { t } = useTranslation()
  const wall = useDegradationWatchWall()

  if (wall.isLoading) return <LoadingState />
  if (wall.isError || !wall.data) {
    return (
      <ErrorState
        title={t('Failed to load the degradation watch')}
        onRetry={() => void wall.refetch()}
      />
    )
  }

  const data = wall.data
  let emptyDescription = t('The degradation watch is currently turned off.')
  if (data.enabled) {
    emptyDescription = t('The first round has not finished yet.')
  }

  return (
    <div className='flex flex-col gap-8'>
      <Alert>
        <AlertDescription>
          {t(
            'Every {{minutes}} minutes each channel gets the same prompt: draw a pelican riding a bicycle as an HTML + SVG animation, using {{model}} at reasoning effort {{effort}}. Same question, same model — a visibly worse drawing on one channel is the signal.',
            {
              minutes: data.interval_minutes,
              model: data.model,
              effort: data.reasoning_effort || '-',
            }
          )}
        </AlertDescription>
      </Alert>

      {data.sections.length === 0 ? (
        <EmptyState
          icon={Bird}
          title={t('No artwork yet')}
          description={emptyDescription}
        />
      ) : (
        data.sections.map((section) => (
          <WallSection
            key={section.channel_id ?? section.title}
            section={section}
          />
        ))
      )}
    </div>
  )
}
