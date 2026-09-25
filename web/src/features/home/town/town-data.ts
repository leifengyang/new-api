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
import type { TFunction } from 'i18next'

export type DistrictId = 'core' | 'language' | 'vision' | 'audio' | 'memory'
export type JourneyStage =
  | 'idle'
  | 'routing'
  | 'memory'
  | 'generating'
  | 'returning'
  | 'complete'

export const DISTRICTS = [
  { id: 'core', color: '#c4b5fd', position: [0, 0.6, 0], radius: 2.5 },
  { id: 'language', color: '#80ead3', position: [-5.7, 0, 0.5], radius: 1.95 },
  { id: 'vision', color: '#ffb9d9', position: [4.6, 0.2, -2.6], radius: 1.95 },
  { id: 'audio', color: '#ffd493', position: [4.5, -0.35, 3.9], radius: 1.7 },
  { id: 'memory', color: '#9fbbff', position: [-5.1, 0.3, -4.3], radius: 1.55 },
] as const satisfies readonly {
  id: DistrictId
  color: string
  position: readonly [number, number, number]
  radius: number
}[]

export function getDistrictCopy(t: TFunction) {
  return {
    core: {
      name: t('Aurora Nexus'),
      kind: t('One gateway. Infinite possibilities.'),
      description: t(
        'Follow a spark through a living constellation of models, memory, and imagination.'
      ),
    },
    language: {
      name: t('Language Grove'),
      kind: t('Words become worlds'),
      description: t(
        'Explore the language models behind conversations, reasoning, and code.'
      ),
    },
    vision: {
      name: t('Prism Garden'),
      kind: t('Give imagination a shape'),
      description: t(
        'Discover a spectrum of image and video models, where ideas become something you can see.'
      ),
    },
    audio: {
      name: t('Echo Pavilion'),
      kind: t('Every idea has a voice'),
      description: t(
        'Explore the models that turn speech into understanding and text into sound.'
      ),
    },
    memory: {
      name: t('Memory Reef'),
      kind: t('Connections give ideas depth'),
      description: t(
        'A crystal landscape inspired by embeddings, retrieval, and the context that connects ideas.'
      ),
    },
  }
}

export function getJourneyCopy(t: TFunction): Record<JourneyStage, string> {
  return {
    idle: t('Send a spark and follow its journey'),
    routing: t('The gateway finds a path'),
    memory: t('Memory brings the context together'),
    generating: t('The model brings an idea to life'),
    returning: t('Your spark is on its way home'),
    complete: t('A new possibility comes to life'),
  }
}

// This is a local visual demonstration; it never calls a model API.
export function journeyAt(seconds: number): {
  stage: JourneyStage
  progress: number
} {
  const progress = Math.min(1, Math.max(0, seconds / 9))
  if (seconds >= 9) return { stage: 'complete', progress }
  if (seconds >= 6.8) return { stage: 'returning', progress }
  if (seconds >= 4.3) return { stage: 'generating', progress }
  if (seconds >= 2) return { stage: 'memory', progress }
  return { stage: 'routing', progress }
}

export interface TownController {
  focus: (district: DistrictId | null) => void
  pause: (paused: boolean) => void
  journey: (district: DistrictId) => void
  zoom: (direction: number) => void
  dispose: () => void
}

export interface TownEvents {
  select: (district: DistrictId) => void
  project: (
    district: DistrictId,
    x: number,
    y: number,
    visible: boolean
  ) => void
  stage: (stage: JourneyStage) => void
  failed: () => void
}
