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
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
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
import { WALL_ROUNDS_PER_PAGE } from '../lib/rounds'
import type { DegradationWatchRunScope } from '../types'

export const degradationWatchKeys = {
  wall: ['degradation-watch', 'wall'] as const,
  html: (id: number) => ['degradation-watch', 'html', id] as const,
  prompt: ['degradation-watch', 'prompt'] as const,
  channels: ['degradation-watch', 'channels'] as const,
}

/**
 * The wall pages by rounds. Only the first page refetches on the interval
 * (TanStack refetches every loaded page, so the whole list stays consistent);
 * lanes come with the first page.
 */
export function useDegradationWatchWall() {
  return useInfiniteQuery({
    queryKey: degradationWatchKeys.wall,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const result = await getDegradationWatchWall({
        before: pageParam,
        rounds: WALL_ROUNDS_PER_PAGE,
      })
      if (!result.success || !result.data) {
        throw createServerError(
          result,
          i18next.t('Failed to load the degradation watch')
        )
      }
      return result.data
    },
    getNextPageParam: (lastPage) => lastPage.next_before || undefined,
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
    staleTime: 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
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
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (scope: DegradationWatchRunScope) => {
      const result = await runDegradationWatch(scope)
      if (!result.success) {
        throw createServerError(result, i18next.t('Failed to start the check'))
      }
      return result.data
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: degradationWatchKeys.channels,
      })
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
