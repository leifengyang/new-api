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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import i18next from 'i18next'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import {
  getDegradationWatchChannels,
  getDegradationWatchPrompt,
  getDegradationWatchRecordHtml,
  getDegradationWatchWall,
  runDegradationWatch,
  setDegradationWatchRecordHidden,
} from '../api'

export const degradationWatchKeys = {
  wall: ['degradation-watch', 'wall'] as const,
  more: ['degradation-watch', 'more'] as const,
  html: (id: number) => ['degradation-watch', 'html', id] as const,
  prompt: ['degradation-watch', 'prompt'] as const,
  channels: ['degradation-watch', 'channels'] as const,
}

export function useDegradationWatchWall() {
  return useQuery({
    queryKey: degradationWatchKeys.wall,
    queryFn: async () => {
      const result = await getDegradationWatchWall()
      if (!result.success || !result.data) {
        throw createServerError(
          result,
          i18next.t('Failed to load the degradation watch')
        )
      }
      return result.data
    },
    refetchInterval: 60_000,
  })
}

/** Artwork is immutable once recorded, so it is cached for the whole session. */
export function useRecordHtml(id: number, enabled: boolean) {
  return useQuery({
    queryKey: degradationWatchKeys.html(id),
    enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      const result = await getDegradationWatchRecordHtml(id)
      if (!result.success || !result.data) {
        throw createServerError(result, i18next.t('Failed to load the artwork'))
      }
      return result.data.html
    },
  })
}

export function useDegradationWatchPrompt() {
  return useQuery({
    queryKey: degradationWatchKeys.prompt,
    queryFn: async () => {
      const result = await getDegradationWatchPrompt()
      if (!result.success || !result.data) {
        throw createServerError(result, i18next.t('Failed to load the prompt'))
      }
      return result.data
    },
  })
}

export function useSetRecordHidden() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: number; hidden: boolean }) => {
      const result = await setDegradationWatchRecordHidden(
        input.id,
        input.hidden
      )
      if (!result.success) {
        throw createServerError(
          result,
          i18next.t('Failed to update the artwork')
        )
      }
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: degradationWatchKeys.wall })
      queryClient.invalidateQueries({ queryKey: degradationWatchKeys.more })
      toast.success(
        input.hidden
          ? i18next.t('Artwork hidden')
          : i18next.t('Artwork shown again')
      )
    },
    onError: (error: Error) => {
      handleServerError(error, i18next.t('Failed to update the artwork'))
    },
  })
}

export function useDegradationWatchChannels() {
  return useQuery({
    queryKey: degradationWatchKeys.channels,
    queryFn: async () => {
      const result = await getDegradationWatchChannels()
      if (!result.success || !result.data) {
        throw createServerError(result, i18next.t('Failed to load channels'))
      }
      return result.data
    },
  })
}

export function useRunDegradationWatch() {
  return useMutation({
    mutationFn: async (channelId?: number) => {
      const result = await runDegradationWatch(channelId)
      if (!result.success) {
        throw createServerError(result, i18next.t('Failed to start the check'))
      }
      return result.data
    },
    onSuccess: () => {
      toast.success(
        i18next.t(
          'Check queued. New artwork appears on the wall once the run finishes.'
        )
      )
    },
    onError: (error: Error) => {
      handleServerError(error, i18next.t('Failed to start the check'))
    },
  })
}

/**
 * Tracks whether an element is near the viewport. Unlike a one-shot lazy
 * loader this flips back to false when the element scrolls away, so an iframe
 * running an animation is torn down instead of burning CPU off-screen.
 */
export function useInViewport<T extends Element>(rootMargin = '200px') {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin])

  return { ref, inView }
}
