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
  group_name?: string
  probe_id?: string
  probe_name?: string
  probe_kind?: string
  verdict?: string
  status?:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'incomplete'
  error_details?: string
  tokens_estimated?: boolean
  id: number
  model_name: string
  reasoning_effort: string
  /** The channel alias; admins see unaliased channels under their name. */
  channel_title: string
  aliased: boolean
  /** Only sent to admins. */
  channel_id?: number
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

/** One swim lane: a configured target, or (admins only) a model since removed. */
export interface DegradationWatchLane {
  model: string
  reasoning_effort: string
  enabled: boolean
  configured: boolean
  total: number
  succeeded: number
  visible: number
  avg_elapsed_ms: number
  last_record_at: number
}

/** One row of the wall: every model and channel answered in the same run. */
export interface DegradationWatchRound {
  key: string
  started_at: number
  records: DegradationWatchRecord[]
}

export interface DegradationWatchWall {
  retention_since?: number
  enabled: boolean
  interval_minutes: number
  /** Only on the first page. */
  lanes?: DegradationWatchLane[]
  rounds: DegradationWatchRound[]
  /** Cursor for the next page; 0 when there are no older rounds. */
  next_before: number
}

export interface DegradationWatchPromptTarget {
  model: string
  reasoning_effort: string
}

export interface DegradationWatchPrompt {
  prompt: string
  targets: DegradationWatchPromptTarget[]
}

export interface DegradationWatchTarget {
  model: string
  group: string
  reasoning_effort: string
  enabled: boolean
}

export interface DegradationWatchChannel {
  id: number
  name: string
  status: number
  alias: string
  /** Target models this channel can run (group and model match, enabled). */
  models: string[]
  last_record_at: number
}

export interface DegradationWatchChannels {
  targets: DegradationWatchTarget[]
  channels: DegradationWatchChannel[]
  available_channels: DegradationWatchAvailableChannel[]
}

export interface DegradationWatchAvailableChannel {
  id: number
  name: string
  status: number
  groups: string[]
  models: string[]
}

export interface DegradationWatchRunResult {
  task_id: string
  status: string
}

/** Scope of a manual run: everything, one target, or one target on one channel. */
export interface DegradationWatchRunScope {
  model?: string
  channelId?: number
}
