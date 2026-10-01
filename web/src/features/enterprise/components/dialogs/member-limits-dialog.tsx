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
import { useMutation, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'

import {
  getEnterpriseMemberOptions,
  updateEnterpriseMemberLimits,
} from '../../api'
import { ERROR_MESSAGES } from '../../constants'
import {
  limitsToSelection,
  parseStoredLimits,
  selectionToLimit,
  type LimitSelection,
} from '../../lib/limits'
import type { EnterpriseMember } from '../../types'
import { useEnterprise } from '../enterprise-provider'

interface MemberLimitsDialogProps {
  member: EnterpriseMember | null
}

const UNRESTRICTED = 'unrestricted'
const RESTRICTED = 'restricted'

/** 一个白名单字段的编辑状态：模式 + 选中项。 */
interface LimitsFieldProps {
  label: string
  description: string
  placeholder: string
  emptyText: string
  options: Array<{ label: string; value: string; hint?: string }>
  selection: LimitSelection
  onChange: (next: LimitSelection) => void
}

function LimitsField(props: LimitsFieldProps) {
  const { t } = useTranslation()

  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Label>{props.label}</Label>
        <ToggleGroup
          value={[props.selection.unrestricted ? UNRESTRICTED : RESTRICTED]}
          onValueChange={(value) => {
            const next = value[0]
            if (next === undefined) return
            props.onChange({
              unrestricted: next === UNRESTRICTED,
              // 切回「限定」时保留原来的选择，避免来回切一次就把选好的清空。
              values: props.selection.values,
            })
          }}
          variant='outline'
          size='sm'
          aria-label={props.label}
        >
          <ToggleGroupItem value={UNRESTRICTED}>
            {t('Unrestricted')}
          </ToggleGroupItem>
          <ToggleGroupItem value={RESTRICTED}>
            {t('Selected only')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {props.selection.unrestricted ? null : (
        <MultiSelect
          options={props.options}
          selected={props.selection.values}
          onChange={(values) => props.onChange({ ...props.selection, values })}
          placeholder={props.placeholder}
          emptyText={props.emptyText}
        />
      )}

      <p className='text-muted-foreground text-xs'>{props.description}</p>
    </div>
  )
}

export function MemberLimitsDialog(props: MemberLimitsDialogProps) {
  const { t } = useTranslation()
  const { openDialog, setOpenDialog, setActiveMember, triggerRefresh } =
    useEnterprise()

  const member = props.member
  const open = openDialog === 'member-limits' && member !== null

  const [groups, setGroups] = useState<LimitSelection>({
    unrestricted: true,
    values: [],
  })
  const [models, setModels] = useState<LimitSelection>({
    unrestricted: true,
    values: [],
  })
  const [seededFor, setSeededFor] = useState<number | null>(null)

  // 库里存的是白名单原文，列表那一列和这里读的是同一份数据、同一套语义。
  const storedGroups = member
    ? parseStoredLimits(member.enterprise_group_limits)
    : null
  const storedModels = member
    ? parseStoredLimits(member.enterprise_model_limits)
    : null
  const storedUnreadable =
    storedGroups?.state === 'unreadable' || storedModels?.state === 'unreadable'

  // 打开时按库里的原文铺一次表单状态。这里比对的是 id 而不是对象引用：列表
  // 刷新会换掉行对象，但人没换，不应该因此丢掉正在编辑的选择。
  if (
    open &&
    member !== null &&
    seededFor !== member.id &&
    storedGroups &&
    storedModels
  ) {
    setSeededFor(member.id)
    setGroups(limitsToSelection(storedGroups))
    setModels(limitsToSelection(storedModels))
  }

  // 候选项是「这个成员本来就能用的」，企业只能在其中做减法；服务端的校验用的
  // 是同一份集合，所以这里给出的每一项都提交得上去。
  const optionsQuery = useQuery({
    queryKey: ['enterprise', 'member-options', member?.id ?? 0],
    queryFn: async () => {
      const res = await getEnterpriseMemberOptions(member?.id ?? 0)
      if (!res.success) throw createServerError(res)
      return res.data ?? null
    },
    enabled: open,
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const groupOptions = useMemo(
    () =>
      (optionsQuery.data?.groups ?? []).map((group) => ({
        label: group.name,
        value: group.name,
        hint: group.desc || undefined,
      })),
    [optionsQuery.data]
  )
  const modelOptions = useMemo(() => {
    const data = optionsQuery.data
    const available =
      groups.unrestricted || !data?.models_by_group
        ? (data?.models ?? [])
        : [
            ...new Set(
              groups.values.flatMap(
                (group) => data.models_by_group?.[group] ?? []
              )
            ),
          ]
    return available.map((model) => ({ label: model, value: model }))
  }, [optionsQuery.data, groups])

  // 服务端不接受「限定到空分组集合」：分组是成员调用的入口，一个都不留等于把
  // 人锁死，所以那一侧必须至少留一个；模型侧的空集是合法的「什么都不放行」。
  const groupsInvalid = !groups.unrestricted && groups.values.length === 0

  const groupLimit = selectionToLimit(groups)
  const modelLimit = selectionToLimit(models)

  const save = useMutation({
    mutationFn: async () => {
      const result = await updateEnterpriseMemberLimits(member?.id ?? 0, {
        group_limits: groupLimit,
        model_limits: modelLimit,
      })
      if (!result.success) throw createServerError(result)
      return result
    },
    onSuccess: () => {
      toast.success(t('Visible range saved'))
      close()
      triggerRefresh()
    },
    onError: (error) => {
      handleServerError(error, t(ERROR_MESSAGES.UPDATE_LIMITS_FAILED))
    },
  })

  function close() {
    setSeededFor(null)
    setActiveMember(null)
    setOpenDialog(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && !save.isPending) close()
  }

  const memberName = member?.username ?? ''

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('Visible Range')}
      description={
        member
          ? t(
              'Narrow what {{username}} can use. This can only remove access, never add: whatever you pick here is intersected with what the platform already allows.',
              { username: memberName }
            )
          : ''
      }
      contentClassName='sm:max-w-lg'
      bodyClassName='space-y-5'
      footer={
        <>
          <Button variant='outline' onClick={close} disabled={save.isPending}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={groupsInvalid || save.isPending}
          >
            {save.isPending ? t('Saving...') : t('Save')}
          </Button>
        </>
      }
    >
      <LimitsField
        label={t('Groups')}
        description={
          groupsInvalid
            ? t('The member must keep at least one group.')
            : t('Groups this member may use.')
        }
        placeholder={t('Select groups...')}
        emptyText={t('No matching items')}
        options={groupOptions}
        selection={groups}
        onChange={setGroups}
      />

      <LimitsField
        label={t('Models')}
        description={t(
          'Models this member may call. Nothing selected means they cannot call any model.'
        )}
        placeholder={t('Select models...')}
        emptyText={t('No matching items')}
        options={modelOptions}
        selection={models}
        onChange={setModels}
      />

      {storedUnreadable ? (
        <p className='text-destructive text-xs'>
          {t(
            'Part of this member’s stored value could not be read, so it is shown as nothing selected. Saving replaces it.'
          )}
        </p>
      ) : null}

      {optionsQuery.isError ? (
        <p className='text-destructive text-xs'>
          {t('Failed to load the available groups and models')}
        </p>
      ) : null}

      <p className='text-muted-foreground text-xs'>
        {t(
          'Candidates come from the groups {{username}} can already use; setting a range never adds access.',
          { username: memberName }
        )}
      </p>
    </Dialog>
  )
}
