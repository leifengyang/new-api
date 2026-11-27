// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import AssetsPage from '@infinite-canvas/workbench/pages/assets'
import CanvasPage from '@infinite-canvas/workbench/pages/canvas'
import CanvasProjectPage from '@infinite-canvas/workbench/pages/canvas/project'
import { AgentPanel } from '@workbench/components/agent/agent-panel'
import { AppProviders } from '@workbench/components/layout/app-providers'
import { AppTopNav } from '@workbench/components/layout/app-top-nav'
import { Images, ImagePlus, LayoutDashboard } from 'lucide-react'
import { lazy, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import {
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom'

import '@infinite-canvas/workbench/styles/app.css'

const ImageWorkbench = lazy(() => import('./image-workbench'))

export function Frame() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const items = [
    {
      id: 'canvas',
      to: '/canvas',
      title: t('My canvases'),
      label: (
        <>
          <LayoutDashboard aria-hidden='true' />
          <span>{t('My canvases')}</span>
        </>
      ),
      active: pathname.startsWith('/canvas'),
    },
    {
      id: 'image',
      to: '/image',
      title: t('Image workbench'),
      label: (
        <>
          <ImagePlus aria-hidden='true' />
          <span>{t('Image workbench')}</span>
        </>
      ),
      active: pathname === '/image',
    },
    {
      id: 'assets',
      to: '/assets',
      title: t('My assets'),
      label: (
        <>
          <Images aria-hidden='true' />
          <span>{t('My assets')}</span>
        </>
      ),
      active: pathname === '/assets',
    },
  ]
  useEffect(() => {
    window.parent.postMessage({ type: 'newapi-canvas-ready' }, location.origin)
  }, [])
  return (
    <div className='bg-background text-foreground flex h-dvh min-h-0 flex-col overflow-hidden'>
      <AppTopNav items={items} brand={null} actions={null} />
      <div className='flex min-h-0 flex-1 overflow-hidden'>
        <div className='min-h-0 min-w-0 flex-1'>
          <Suspense
            fallback={
              <div role='status' className='p-6'>
                {t('Loading…')}
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
        <AgentPanel />
      </div>
    </div>
  )
}

const router = createHashRouter([
  {
    element: <Frame />,
    children: [
      { path: '/', element: <Navigate to='/canvas' replace /> },
      { path: '/canvas', element: <CanvasPage /> },
      { path: '/canvas/:id', element: <CanvasProjectPage /> },
      { path: '/image', element: <ImageWorkbench /> },
      { path: '/assets', element: <AssetsPage /> },
      { path: '*', element: <Navigate to='/canvas' replace /> },
    ],
  },
])

const rootElement = document.querySelector('#root')
if (!rootElement) throw new Error('CANVAS_ROOT_MISSING')
createRoot(rootElement).render(
  <AppProviders>
    <RouterProvider router={router} />
  </AppProviders>
)
