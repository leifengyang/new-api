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
import { Link, useLocation } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { useSidebarView } from '@/hooks/use-sidebar-view'

import { checkIsActive } from '../lib/url-utils'

export function AppBreadcrumb() {
  const { t } = useTranslation()
  const href = useLocation({ select: (location) => location.href })
  const { navGroups } = useSidebarView()
  let groupTitle = ''
  let pageTitle = t('Dashboard')

  for (const group of navGroups) {
    const activeItem = group.items.find((item) => checkIsActive(href, item))
    if (!activeItem) continue
    groupTitle = group.title
    pageTitle =
      activeItem.items?.find((item) => checkIsActive(href, item))?.title ??
      activeItem.title
    break
  }

  return (
    <Breadcrumb className='min-w-0'>
      <BreadcrumbList className='flex-nowrap'>
        <BreadcrumbItem className='hidden min-w-0 md:inline-flex'>
          <BreadcrumbLink
            render={
              <Link to='/dashboard/$section' params={{ section: 'overview' }} />
            }
          >
            {t('Dashboard')}
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className='hidden md:block' />
        {groupTitle && (
          <>
            <BreadcrumbItem className='hidden min-w-0 lg:inline-flex'>
              <span className='truncate'>{groupTitle}</span>
            </BreadcrumbItem>
            <BreadcrumbSeparator className='hidden lg:block' />
          </>
        )}
        <BreadcrumbItem className='min-w-0'>
          <BreadcrumbPage className='truncate'>{pageTitle}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
