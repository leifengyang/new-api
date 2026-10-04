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
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Input } from '@/components/ui/input'

/** Shared local-image reader for settings that persist an image with their draft. */
export function ImageFileInput(props: {
  id: string
  disabled?: boolean
  maxBytes?: number
  invalidFileMessage?: string
  onImageRead: (image: string) => void
  onReadingChange: (reading: boolean) => void
}) {
  const { t } = useTranslation()
  const [reading, setReading] = useState(false)
  const currentReader = useRef<FileReader | null>(null)
  useEffect(
    () => () => {
      const reader = currentReader.current
      currentReader.current = null
      reader?.abort()
    },
    []
  )
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (
      !file.size ||
      file.size > (props.maxBytes ?? 1024 * 1024) ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
        file.type
      )
    ) {
      toast.error(
        props.invalidFileMessage ??
          t('Choose a PNG, JPEG, WebP or GIF image up to 1 MB')
      )
      return
    }
    currentReader.current?.abort()
    const reader = new FileReader()
    currentReader.current = reader
    setReading(true)
    props.onReadingChange(true)
    reader.addEventListener('load', () => {
      if (currentReader.current !== reader) return
      if (typeof reader.result === 'string') props.onImageRead(reader.result)
    })
    reader.addEventListener('error', () => {
      if (currentReader.current === reader) {
        toast.error(t('Failed to read image'))
      }
    })
    reader.addEventListener('loadend', () => {
      if (currentReader.current !== reader) return
      currentReader.current = null
      setReading(false)
      props.onReadingChange(false)
    })
    reader.readAsDataURL(file)
  }
  return (
    <Input
      id={props.id}
      type='file'
      accept='image/png,image/jpeg,image/webp,image/gif'
      disabled={props.disabled || reading}
      onChange={upload}
    />
  )
}
