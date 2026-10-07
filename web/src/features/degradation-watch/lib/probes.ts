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
import { z } from 'zod'

export const probePlanSchema = z
  .object({
    enabled: z.boolean(),
    concurrency: z.coerce.number().int().min(1).max(32),
    timeout_seconds: z.coerce.number().int().min(30).max(3600),
    probes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().trim().min(1).max(100),
            kind: z.enum(['text', 'drawing']),
            prompt: z.string().trim().min(1).max(20000),
            expected: z.string().max(2000),
            intermediate_expected: z
              .string()
              .trim()
              .max(2000)
              .nullable()
              .optional(),
            match: z.string(),
            interval_minutes: z.coerce.number().int().min(1).max(1440),
          })
          .refine(
            (p) =>
              p.kind === 'drawing' ||
              (p.expected.trim() !== '' &&
                (!p.intermediate_expected?.trim() ||
                  p.intermediate_expected.trim() !== p.expected.trim()) &&
                ['exact', 'contains'].includes(p.match)),
            { path: ['expected'], message: 'Expected answer is required' }
          )
      )
      .max(20),
    targets: z
      .array(
        z.object({
          group: z.string().min(1),
          channel_id: z.coerce.number().int().positive(),
          model: z.string().min(1),
          reasoning_effort: z.string(),
          enabled: z.boolean(),
          public: z.boolean(),
          probes: z.array(
            z.object({
              probe_id: z.string(),
              enabled: z.boolean(),
              public: z.boolean().optional(),
              reasoning_effort: z
                .enum(['', 'minimal', 'low', 'medium', 'high', 'xhigh'])
                .optional(),
              interval_minutes: z.coerce.number().int().min(0).max(1440),
            })
          ),
        })
      )
      .max(200),
  })
  .superRefine((plan, ctx) => {
    const targets = new Set<string>()
    plan.targets.forEach((target, index) => {
      const key = JSON.stringify([
        target.group,
        target.model,
        target.channel_id,
      ])
      if (targets.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', index, 'model'],
          message: 'Duplicate target or public channel',
        })
      }
      targets.add(key)
    })
  })

export type ProbePlan = z.infer<typeof probePlanSchema>
export type ProbeTarget = ProbePlan['targets'][number]

export function intermediateAnswer(
  expected: string,
  configured?: string | null
) {
  return configured?.trim() ?? (expected.trim() === '高市早苗' ? '石破茂' : '')
}

export function probeVerdict(record: {
  status?: string
  success: boolean
  verdict?: string
  failure_reason: string
}) {
  if (record.status === 'queued' || record.status === 'running') {
    return record.status
  }
  if (record.verdict === 'intermediate') return 'intermediate'
  if (record.success) return 'passed'
  if (
    record.verdict === 'mismatch' ||
    ['no_html', 'no_svg', 'empty_content', 'answer_mismatch'].includes(
      record.failure_reason
    )
  ) {
    return 'mismatch'
  }
  return 'error'
}
