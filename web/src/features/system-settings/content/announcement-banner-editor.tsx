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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AnnouncementBanner } from '@/features/dashboard/types'

import { ImageFileInput } from '../components/image-file-input'

export function AnnouncementBannerEditor({
  banner,
  onSave,
  onPreview,
  disabled,
}: {
  banner: AnnouncementBanner
  onSave: (banner: AnnouncementBanner) => Promise<boolean>
  onPreview: (target: 'home' | 'authenticated') => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const [imageUrl, setImageUrl] = useState(banner.imageUrl)
  const [linkUrl, setLinkUrl] = useState(banner.linkUrl)
  const [reading, setReading] = useState(false)
  useEffect(() => {
    setImageUrl(banner.imageUrl)
    setLinkUrl(banner.linkUrl)
  }, [banner])
  const dirty = imageUrl !== banner.imageUrl || linkUrl !== banner.linkUrl
  const pending = disabled || reading
  return (
    <div className='bg-muted/20 space-y-4 rounded-xl border p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <h3 className='text-sm font-semibold'>{t('Permanent announcement')}</h3>
        <StatusBadge
          copyable={false}
          variant={banner.published ? 'success' : 'neutral'}
          label={banner.published ? t('Published') : t('Draft')}
        />
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'One image shared by both popup locations. Save a draft, preview the complete popup, then confirm publication.'
        )}
      </p>
      <div className='grid gap-4 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='announcement-image-url'>{t('Image URL')}</Label>
          <Input
            id='announcement-image-url'
            disabled={pending}
            value={imageUrl.startsWith('data:') ? '' : imageUrl}
            placeholder='https://example.com/announcement.png'
            onChange={(event) => setImageUrl(event.target.value)}
            maxLength={2048}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='announcement-image-file'>{t('Upload image')}</Label>
          <ImageFileInput
            id='announcement-image-file'
            disabled={pending}
            onImageRead={setImageUrl}
            onReadingChange={setReading}
          />
        </div>
        <div className='space-y-2 sm:col-span-2'>
          <Label htmlFor='announcement-link'>
            {t('Image link (optional)')}
          </Label>
          <Input
            id='announcement-link'
            value={linkUrl}
            maxLength={2048}
            disabled={pending}
            placeholder='https://example.com/community'
            onChange={(event) => setLinkUrl(event.target.value)}
          />
        </div>
      </div>
      {imageUrl && (
        <div className='flex items-center gap-4'>
          <img
            src={imageUrl}
            alt={t('Permanent announcement')}
            className='bg-background max-h-28 max-w-48 rounded-lg border object-contain'
          />
          <Button
            size='sm'
            variant='ghost'
            disabled={pending}
            onClick={() => {
              setImageUrl('')
              setLinkUrl('')
            }}
          >
            {t('Remove image')}
          </Button>
        </div>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={pending || !dirty}
          onClick={() =>
            void onSave({
              imageUrl: imageUrl.trim(),
              linkUrl: linkUrl.trim(),
              published: false,
            })
          }
        >
          {t('Save image draft')}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={pending || dirty}
          onClick={() => onPreview('home')}
        >
          {t('Preview homepage popup')}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={pending || dirty}
          onClick={() => onPreview('authenticated')}
        >
          {t('Preview login popup')}
        </Button>
        {banner.published && (
          <Button
            size='sm'
            variant='ghost'
            disabled={pending}
            onClick={() => void onSave({ ...banner, published: false })}
          >
            {t('Unpublish image')}
          </Button>
        )}
      </div>
    </div>
  )
}
