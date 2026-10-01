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
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Trash2, Eye } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StaticDataTable } from '@/components/data-table/static/static-data-table'
import { StaticRowActions } from '@/components/data-table/static/static-row-actions'
import { DateTimePicker } from '@/components/datetime-picker'
import { Dialog } from '@/components/dialog'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AnnouncementBoardDialog } from '@/features/dashboard/components/overview/announcement-board-dialog'
import {
  latestPopupAnnouncements,
  announcementSummary,
} from '@/features/dashboard/lib/announcements'
import type { AnnouncementBanner } from '@/features/dashboard/types'
import dayjs from '@/lib/dayjs'
import { handleServerError } from '@/lib/handle-server-error'

import { SettingsSwitchField } from '../components/settings-form-layout'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import { AnnouncementBannerEditor } from './announcement-banner-editor'

type Announcement = {
  title?: string
  id: number
  content: string
  publishDate: string
  type: 'default' | 'ongoing' | 'success' | 'warning' | 'error'
  extra?: string
  popupTarget?: 'home' | 'authenticated'
  published?: boolean
  revision?: string
}

type AnnouncementsSectionProps = {
  enabled: boolean
  data: string
  bannerData?: string
}

const announcementSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(100, 'Title must be less than 100 characters'),
  content: z
    .string()
    .min(1, 'Content is required')
    .max(500, 'Content must be less than 500 characters'),
  publishDate: z.string().min(1, 'Publish date is required'),
  type: z.enum(['default', 'ongoing', 'success', 'warning', 'error']),
  popupTarget: z.enum(['home', 'authenticated']),
  extra: z
    .string()
    .max(100, 'Extra must be less than 100 characters')
    .optional(),
})

type AnnouncementFormValues = z.infer<typeof announcementSchema>

const ANNOUNCEMENT_FORM_ID = 'announcement-form'

const typeOptions = [
  {
    value: 'default',
    label: 'Default',
    color: 'bg-gray-500',
    badgeVariant: 'neutral' as const,
  },
  {
    value: 'ongoing',
    label: 'Ongoing',
    color: 'bg-blue-500',
    badgeVariant: 'info' as const,
  },
  {
    value: 'success',
    label: 'Success',
    color: 'bg-green-500',
    badgeVariant: 'success' as const,
  },
  {
    value: 'warning',
    label: 'Warning',
    color: 'bg-orange-500',
    badgeVariant: 'warning' as const,
  },
  {
    value: 'error',
    label: 'Error',
    color: 'bg-red-500',
    badgeVariant: 'danger' as const,
  },
]

export function AnnouncementsSection({
  enabled,
  data,
  bannerData = '{}',
}: AnnouncementsSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [preview, setPreview] = useState<Announcement | null>(null)
  const [banner, setBanner] = useState<AnnouncementBanner>({
    imageUrl: '',
    linkUrl: '',
    published: false,
  })
  const [imagePreview, setImagePreview] = useState<{
    banner: AnnouncementBanner
    target: 'home' | 'authenticated'
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [editingAnnouncement, setEditingAnnouncement] =
    useState<Announcement | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<'single' | 'batch'>('single')

  const form = useForm<AnnouncementFormValues>({
    resolver: zodResolver(announcementSchema),
    defaultValues: {
      title: '',
      content: '',
      publishDate: new Date().toISOString(),
      type: 'default',
      extra: '',
      popupTarget: 'authenticated',
    },
  })

  useEffect(() => {
    try {
      const parsed = JSON.parse(data || '[]')
      if (Array.isArray(parsed)) {
        setAnnouncements(
          parsed.map((item, idx) => ({
            ...item,
            id: item.id || idx + 1,
          }))
        )
      }
    } catch {
      setAnnouncements([])
    }
  }, [data])

  useEffect(() => {
    setIsEnabled(enabled)
  }, [enabled])

  useEffect(() => {
    try {
      const parsed = JSON.parse(
        bannerData || '{}'
      ) as Partial<AnnouncementBanner>
      setBanner({
        imageUrl: parsed.imageUrl ?? '',
        linkUrl: parsed.linkUrl ?? '',
        published: parsed.published === true,
        revision: parsed.revision,
      })
    } catch {
      setBanner({ imageUrl: '', linkUrl: '', published: false })
    }
  }, [bannerData])

  const persistBanner = async (next: AnnouncementBanner) => {
    try {
      await updateOption.mutateAsync({
        key: 'console_setting.announcements_banner',
        value: JSON.stringify(next),
      })
      setBanner(next)
      return true
    } catch (error) {
      handleServerError(error, t('Failed to save announcements'))
      return false
    }
  }

  const handleToggleEnabled = async (checked: boolean) => {
    try {
      await updateOption.mutateAsync({
        key: 'console_setting.announcements_enabled',
        value: checked,
      })
      setIsEnabled(checked)
      toast.success(t('Setting saved'))
    } catch (error) {
      handleServerError(error, t('Failed to update setting'))
    }
  }

  const handleAdd = () => {
    setEditingAnnouncement(null)
    form.reset({
      title: '',
      content: '',
      publishDate: new Date().toISOString(),
      type: 'default',
      extra: '',
      popupTarget: 'authenticated',
    })
    setShowDialog(true)
  }

  const handleEdit = (announcement: Announcement) => {
    setEditingAnnouncement(announcement)
    form.reset({
      title:
        announcement.title ||
        announcementSummary(announcement.content).slice(0, 100),
      content: announcement.content,
      publishDate: announcement.publishDate,
      type: announcement.type,
      extra: announcement.extra || '',
      popupTarget: announcement.popupTarget ?? 'authenticated',
    })
    setShowDialog(true)
  }

  const handleDelete = (announcement: Announcement) => {
    setEditingAnnouncement(announcement)
    setDeleteTarget('single')
    setShowDeleteDialog(true)
  }

  const handleBatchDelete = () => {
    if (selectedIds.length === 0) {
      toast.error(t('Please select items to delete'))
      return
    }
    setDeleteTarget('batch')
    setShowDeleteDialog(true)
  }

  const persistAnnouncements = async (next: Announcement[]) => {
    try {
      await updateOption.mutateAsync({
        key: 'console_setting.announcements',
        value: JSON.stringify(next),
      })
      setAnnouncements(next)
      return true
    } catch (error) {
      handleServerError(error, t('Failed to save announcements'))
      return false
    }
  }

  const confirmDelete = async () => {
    const ids =
      deleteTarget === 'single' ? [editingAnnouncement?.id] : selectedIds
    if (
      await persistAnnouncements(
        announcements.filter((item) => !ids.includes(item.id))
      )
    ) {
      setSelectedIds([])
      setShowDeleteDialog(false)
      setEditingAnnouncement(null)
    }
  }

  const handleSubmitForm = async (values: AnnouncementFormValues) => {
    const draft: Announcement = {
      ...values,
      id:
        editingAnnouncement?.id ??
        Math.max(Date.now(), ...announcements.map((item) => item.id + 1)),
      published: false,
    }
    const next = editingAnnouncement
      ? announcements.map((item) => (item.id === draft.id ? draft : item))
      : [...announcements, draft]
    if (await persistAnnouncements(next)) {
      setShowDialog(false)
      toast.success(
        t(
          'Draft saved. Test the popup and confirm publication to show it to users.'
        )
      )
    }
  }

  const handlePublish = async () => {
    if (updateOption.isPending || !isEnabled) return
    if (imagePreview) {
      if (
        await persistBanner({
          ...imagePreview.banner,
          published: true,
          revision: crypto.randomUUID(),
        })
      ) {
        setImagePreview(null)
      }
      return
    }
    if (!preview || updateOption.isPending) return
    const published = {
      ...preview,
      published: true,
      revision: crypto.randomUUID(),
    }
    if (
      await persistAnnouncements(
        announcements.map((item) => (item.id === preview.id ? published : item))
      )
    ) {
      setPreview(null)
    }
  }

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? announcements.map((item) => item.id) : [])
  }

  const toggleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? [...prev, id] : prev.filter((item) => item !== id)
    )
  }

  const sortedAnnouncements = useMemo(() => {
    return [...announcements].sort((a, b) => {
      return (
        new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime()
      )
    })
  }, [announcements])

  const previewItems = latestPopupAnnouncements(
    announcements.map((item) =>
      item.id === preview?.id ? { ...preview, published: true } : item
    ),
    preview?.popupTarget ?? imagePreview?.target ?? 'authenticated',
    preview
      ? Math.max(Date.now(), new Date(preview.publishDate).getTime())
      : Date.now()
  )

  const getRelativeTime = (date: string) => {
    const now = new Date()
    const past = new Date(date)
    const diffMs = now.getTime() - past.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  return (
    <SettingsSection title={t('Announcements')}>
      <div className='space-y-4'>
        <AnnouncementBannerEditor
          banner={banner}
          onSave={persistBanner}
          disabled={updateOption.isPending}
          onPreview={(target) =>
            setImagePreview({ banner: { ...banner }, target })
          }
        />
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              onClick={handleAdd}
              size='sm'
              disabled={updateOption.isPending}
            >
              <Plus className='mr-2 h-4 w-4' />
              {t('Add Announcement')}
            </Button>
            <Button
              onClick={handleBatchDelete}
              size='sm'
              variant='destructive'
              disabled={selectedIds.length === 0 || updateOption.isPending}
            >
              <Trash2 className='mr-2 h-4 w-4' />
              {t('Delete (')}
              {selectedIds.length})
            </Button>
          </div>
          <SettingsSwitchField
            controlId='announcements-enabled'
            disabled={updateOption.isPending}
            checked={isEnabled}
            onCheckedChange={handleToggleEnabled}
            label={t('Enabled')}
            className='py-0'
          />
        </div>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Save a draft, test the popup, then confirm publication. Editing a published announcement takes it offline until you confirm again.'
          )}
        </p>

        <StaticDataTable
          data={sortedAnnouncements}
          getRowKey={(announcement) => announcement.id}
          emptyContent={t(
            'No announcements yet. Click "Add Announcement" to create one.'
          )}
          columns={[
            {
              id: 'select',
              header: (
                <Checkbox
                  checked={
                    selectedIds.length === announcements.length &&
                    announcements.length > 0
                  }
                  onCheckedChange={toggleSelectAll}
                />
              ),
              className: 'w-12',
              cell: (announcement) => (
                <Checkbox
                  checked={selectedIds.includes(announcement.id)}
                  onCheckedChange={(checked) =>
                    toggleSelectOne(announcement.id, checked as boolean)
                  }
                />
              ),
            },
            {
              id: 'content',
              header: t('Title'),
              cellClassName: 'max-w-xs truncate',
              cell: (announcement) =>
                announcement.title || announcementSummary(announcement.content),
            },
            {
              id: 'publish-date',
              header: t('Publish Date'),
              cell: (announcement) => (
                <div className='flex flex-col gap-1'>
                  <span className='text-sm font-medium'>
                    {getRelativeTime(announcement.publishDate)}
                  </span>
                  <span className='text-muted-foreground text-xs'>
                    {dayjs(announcement.publishDate).format(
                      'YYYY-MM-DD HH:mm:ss'
                    )}
                  </span>
                </div>
              ),
            },
            {
              id: 'type',
              header: t('Type'),
              cell: (announcement) => (
                <StatusBadge
                  label={t(
                    typeOptions.find((opt) => opt.value === announcement.type)
                      ?.label ?? 'Default'
                  )}
                  variant={
                    typeOptions.find((opt) => opt.value === announcement.type)
                      ?.badgeVariant ?? 'neutral'
                  }
                  copyable={false}
                />
              ),
            },
            {
              id: 'extra',
              header: t('Extra'),
              cellClassName: 'text-muted-foreground max-w-xs truncate',
              cell: (announcement) => announcement.extra || '-',
            },
            {
              id: 'publication',
              header: t('Status'),
              cell: (announcement) => (
                <StatusBadge
                  copyable={false}
                  variant={
                    announcement.published === false ? 'neutral' : 'success'
                  }
                  label={
                    announcement.published === false
                      ? t('Draft')
                      : t('Published')
                  }
                />
              ),
            },
            {
              id: 'popup-target',
              header: t('Popup location'),
              cell: (announcement) => {
                if (!announcement.popupTarget) return t('No popup')
                return announcement.popupTarget === 'home'
                  ? t('Homepage popup')
                  : t('After login popup')
              },
            },
            {
              id: 'actions',
              header: t('Actions'),
              cell: (announcement) => (
                <div className='flex items-center justify-end gap-1'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={updateOption.isPending}
                    onClick={() => setPreview(announcement)}
                  >
                    <Eye className='size-4' />
                    {t('Test popup')}
                  </Button>
                  {announcement.published !== false && (
                    <Button
                      size='sm'
                      variant='ghost'
                      disabled={updateOption.isPending}
                      onClick={() =>
                        void persistAnnouncements(
                          announcements.map((item) =>
                            item.id === announcement.id
                              ? { ...item, published: false }
                              : item
                          )
                        )
                      }
                    >
                      {t('Unpublish')}
                    </Button>
                  )}
                  <StaticRowActions
                    editLabel={t('Edit')}
                    deleteLabel={t('Delete')}
                    menuLabel={t('Open menu')}
                    onEdit={() => handleEdit(announcement)}
                    onDelete={() => handleDelete(announcement)}
                    editDisabled={updateOption.isPending}
                    deleteDisabled={updateOption.isPending}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>

      <Dialog
        open={showDialog}
        onOpenChange={setShowDialog}
        title={
          editingAnnouncement ? t('Edit Announcement') : t('Add Announcement')
        }
        description={t(
          'Create or update system announcements for the dashboard'
        )}
        contentClassName='max-w-2xl'
        contentHeight='auto'
        bodyClassName='space-y-4'
        footer={
          <>
            <Button
              type='button'
              variant='outline'
              onClick={() => setShowDialog(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='submit'
              form={ANNOUNCEMENT_FORM_ID}
              disabled={updateOption.isPending}
            >
              {t('Save draft')}
            </Button>
          </>
        }
      >
        <Form {...form}>
          <form
            id={ANNOUNCEMENT_FORM_ID}
            onSubmit={form.handleSubmit(handleSubmitForm)}
            className='space-y-4'
          >
            <FormField
              control={form.control}
              name='popupTarget'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Popup location')}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    items={[
                      { value: 'home', label: t('Homepage popup') },
                      { value: 'authenticated', label: t('After login popup') },
                    ]}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value='home'>
                        {t('Homepage popup')}
                      </SelectItem>
                      <SelectItem value='authenticated'>
                        {t('After login popup')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(
                      'Homepage announcements are public. Login announcements are only available to signed-in users.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='title'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Title')}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={100} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='content'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Content')}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t(
                        'Enter announcement content (supports Markdown/HTML)'
                      )}
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('Maximum 500 characters. Supports Markdown and HTML.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='publishDate'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Publish Date')}</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      value={field.value ? new Date(field.value) : undefined}
                      onChange={(date) =>
                        field.onChange(date ? date.toISOString() : '')
                      }
                      placeholder={t('Select publish date')}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Date and time when this announcement should be displayed'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='type'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Type')}</FormLabel>
                  <Select
                    items={typeOptions.map((option) => ({
                      value: option.value,
                      label: (
                        <div className='flex items-center gap-2'>
                          <div
                            className={`h-3 w-3 rounded-full ${option.color}`}
                          />
                          {t(option.label)}
                        </div>
                      ),
                    }))}
                    onValueChange={field.onChange}
                    value={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t('Select announcement type')}
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {typeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            <div className='flex items-center gap-2'>
                              <div
                                className={`h-3 w-3 rounded-full ${option.color}`}
                              />
                              {t(option.label)}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='extra'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Extra Notes (Optional)')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t('Additional information')}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Optional supplementary information (max 100 characters)'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
      </Dialog>

      <AnnouncementBoardDialog
        key={preview?.id ?? imagePreview?.target ?? 'closed'}
        open={preview !== null || imagePreview !== null}
        onOpenChange={(open) => {
          if (!open && !updateOption.isPending) {
            setPreview(null)
            setImagePreview(null)
          }
        }}
        items={previewItems}
        banner={imagePreview?.banner ?? (banner.published ? banner : null)}
        description={
          <span className='space-y-1'>
            <span className='block'>
              {preview?.popupTarget === 'home' ||
              imagePreview?.target === 'home'
                ? t('Preview homepage popup')
                : t('Preview login popup')}
            </span>
            {preview &&
              new Date(preview.publishDate).getTime() > Date.now() && (
                <span className='block'>
                  {t('Publish Date')}:{' '}
                  {dayjs(preview.publishDate).format('YYYY-MM-DD HH:mm:ss')}
                </span>
              )}
            {preview &&
              !previewItems.some((item) => item.id === preview.id) && (
                <span className='block'>
                  {t(
                    'This announcement is older than the latest three and will not appear in the popup.'
                  )}
                </span>
              )}
          </span>
        }
        footer={
          <>
            <Button
              variant='outline'
              disabled={updateOption.isPending}
              onClick={() => {
                setPreview(null)
                setImagePreview(null)
              }}
            >
              {t('Close')}
            </Button>
            {(preview?.published === false ||
              (imagePreview &&
                !imagePreview.banner.published &&
                imagePreview.banner.imageUrl)) && (
              <Button
                disabled={updateOption.isPending || !isEnabled}
                onClick={handlePublish}
              >
                {t('Confirm publication')}
              </Button>
            )}
          </>
        }
      />

      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title={t('Are you sure?')}
        desc={
          deleteTarget === 'single'
            ? t('This announcement will be removed from the list.')
            : t('{{count}} announcements will be removed from the list.', {
                count: selectedIds.length,
              })
        }
        confirmText={t('Delete')}
        destructive
        isLoading={updateOption.isPending}
        handleConfirm={() => void confirmDelete()}
      />
    </SettingsSection>
  )
}
