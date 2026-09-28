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
export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

/** One attempt as the wall lists it. The artwork itself is fetched separately. */
export interface DegradationWatchRecord {
  id: number
  model_name: string
  reasoning_effort: string
  success: boolean
  /** A reason code (see FAILURE_REASON_LABELS) or, for admins, the raw upstream error. */
  failure_reason: string
  elapsed_ms: number
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
  hidden: boolean
  created_at: number
}

export interface DegradationWatchSection {
  /** The channel alias; admins also see unaliased channels under their name. */
  title: string
  channel_id?: number
  channel_name?: string
  aliased: boolean
  total: number
  succeeded: number
  visible: number
  last_record_at: number
  records: DegradationWatchRecord[]
}

export interface DegradationWatchWall {
  enabled: boolean
  model: string
  reasoning_effort: string
  interval_minutes: number
  sections: DegradationWatchSection[]
}

export interface DegradationWatchPrompt {
  prompt: string
  model: string
  reasoning_effort: string
}

export interface DegradationWatchChannel {
  id: number
  name: string
  status: number
  has_model: boolean
  eligible: boolean
  alias: string
  last_record_at: number
}

export interface DegradationWatchChannels {
  group: string
  model: string
  channels: DegradationWatchChannel[]
}

export interface DegradationWatchRunResult {
  task_id: string
  status: string
}
