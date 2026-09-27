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
import { createFileRoute, redirect } from '@tanstack/react-router'
import z from 'zod'

import { Enterprise } from '@/features/enterprise'
import { useAuthStore } from '@/stores/auth-store'

const enterpriseSearchSchema = z.object({
  page: z.number().optional().catch(1),
  pageSize: z.number().optional().catch(undefined),
  filter: z.string().optional().catch(''),
  status: z
    .array(z.enum(['1', '2']))
    .optional()
    .catch([]),
})

export const Route = createFileRoute('/_authenticated/enterprise/')({
  // 这一层只是渲染准入：企业账号标记没打开就不给看这一页。真正的授权在服务端
  // （EnterpriseAuth 中间件 + 每个查询按归属收窄），改前端状态越不过它。
  beforeLoad: () => {
    const { auth } = useAuthStore.getState()

    if (!auth.user?.is_enterprise) {
      throw redirect({
        to: '/403',
      })
    }
  },
  validateSearch: enterpriseSearchSchema,
  component: Enterprise,
})
