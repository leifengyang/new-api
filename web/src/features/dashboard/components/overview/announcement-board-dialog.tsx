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
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  ImageIcon,
  Megaphone,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { RichContent } from '@/components/rich-content'
import { Button } from '@/components/ui/button'
import { announcementSummary } from '@/features/dashboard/lib/announcements'
import type {
  AnnouncementBanner,
  AnnouncementItem,
} from '@/features/dashboard/types'
import { formatDateTimeObject } from '@/lib/time'

export function AnnouncementBoardDialog({
  open,
  onOpenChange,
  items,
  banner,
  footer,
  description,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: AnnouncementItem[]
  banner?: AnnouncementBanner | null
  footer?: ReactNode
  description?: ReactNode
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<AnnouncementItem | null>(null)
  const [failedImage, setFailedImage] = useState('')
  const image =
    banner?.imageUrl && failedImage !== banner.imageUrl ? (
      <img
        src={banner.imageUrl}
        alt={t('Permanent announcement')}
        onError={() => setFailedImage(banner.imageUrl)}
        className='max-h-64 w-full rounded-xl object-contain sm:max-h-[420px]'
      />
    ) : (
      <div className='text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-3 px-6 text-center text-sm sm:min-h-80'>
        <ImageIcon className='size-8 opacity-40' />
        {t('Permanent announcement')}
        <span className='text-xs'>{t('No announcement image available')}</span>
      </div>
    )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected(null)
        onOpenChange(next)
      }}
      title={t('Announcements')}
      description={description}
      contentClassName='sm:max-w-4xl'
      bodyClassName='space-y-4'
      footer={footer}
    >
      <div className='grid gap-5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]'>
        <aside
          className='bg-muted/40 flex min-w-0 flex-col justify-center rounded-2xl border p-3 sm:p-4'
          aria-label={t('Permanent announcement')}
        >
          {banner?.linkUrl && banner.imageUrl ? (
            <a
              href={banner.linkUrl}
              target='_blank'
              rel='noopener noreferrer'
              className='focus-visible:ring-ring rounded-xl outline-none focus-visible:ring-2'
            >
              {image}
              <span className='text-muted-foreground mt-3 flex items-center justify-center gap-1 text-xs'>
                {t('Open link')}
                <ArrowUpRight className='size-3' />
              </span>
            </a>
          ) : (
            image
          )}
        </aside>
        <section
          className='min-w-0 space-y-3'
          aria-label={t('Latest announcements')}
        >
          {selected ? (
            <>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setSelected(null)}
              >
                <ArrowLeft className='size-4' />
                {t('Back to announcements')}
              </Button>
              <article className='space-y-4 rounded-2xl border p-4 sm:p-5'>
                <h3 className='text-base leading-snug font-semibold break-words'>
                  {selected.title ||
                    announcementSummary(selected.content).slice(0, 60)}
                </h3>
                {selected.publishDate && (
                  <p className='text-muted-foreground text-xs'>
                    {formatDateTimeObject(new Date(selected.publishDate))}
                  </p>
                )}
                <RichContent
                  breaks
                  content={selected.content}
                  className='text-sm break-words'
                />
                {selected.extra && (
                  <RichContent
                    breaks
                    content={selected.extra}
                    className='text-muted-foreground border-t pt-4 text-sm break-words'
                  />
                )}
              </article>
            </>
          ) : (
            <>
              <h3 className='flex items-center gap-2 px-1 text-sm font-medium'>
                <Megaphone className='text-primary size-4' />
                {t('Latest announcements')}
              </h3>
              {items.length === 0 && (
                <p className='text-muted-foreground rounded-2xl border border-dashed p-6 text-sm'>
                  {t('No announcements')}
                </p>
              )}
              {items.map((item, index) => (
                <Button
                  key={item.id ?? index}
                  type='button'
                  variant='outline'
                  onClick={() => setSelected(item)}
                  className='group block h-auto w-full rounded-2xl p-4 text-start font-normal whitespace-normal sm:p-5'
                >
                  <span className='mb-2 flex items-center justify-between gap-3'>
                    <span className='text-muted-foreground text-xs'>
                      {item.publishDate &&
                        formatDateTimeObject(new Date(item.publishDate))}
                    </span>
                    <ChevronRight className='text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5' />
                  </span>
                  <span className='mb-1.5 line-clamp-1 text-sm font-semibold break-all'>
                    {item.title ||
                      announcementSummary(item.content).slice(0, 60)}
                  </span>
                  <span className='text-muted-foreground line-clamp-2 text-xs leading-relaxed break-all'>
                    {announcementSummary(item.content)}
                  </span>
                </Button>
              ))}
            </>
          )}
        </section>
      </div>
    </Dialog>
  )
}
