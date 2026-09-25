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
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { TownBackdrop } from './town-backdrop'
import {
  DISTRICTS,
  getDistrictCopy,
  getJourneyCopy,
  type DistrictId,
  type JourneyStage,
  type TownController,
} from './town-data'
import { TownGlyph } from './town-glyph'

import '@/styles/aurora-town.css'

export function TownExperience(props: { isAuthenticated: boolean }) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<TownController | null>(null)
  const labelsRef = useRef(new Map<DistrictId, HTMLButtonElement>())
  const [selected, setSelected] = useState<DistrictId>('core')
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>(
    'loading'
  )
  const [stage, setStage] = useState<JourneyStage>('idle')
  const [paused, setPaused] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const [attempt, setAttempt] = useState(0)
  const copy = getDistrictCopy(t)
  const journeyCopy = getJourneyCopy(t)
  const journeyRunning = stage !== 'idle' && stage !== 'complete'
  const current = copy[selected]
  const color = DISTRICTS.find((item) => item.id === selected)?.color

  const selectDistrict = useCallback((district: DistrictId) => {
    setSelected(district)
    controllerRef.current?.focus(district)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let controller: TownController | undefined
    setStatus('loading')
    setStage('idle')
    setSelected('core')
    const load = async () => {
      try {
        const { createTownScene } = await import('./town-scene')
        if (cancelled) return
        controller = createTownScene(host, {
          select: selectDistrict,
          stage: setStage,
          project(district, x, y, visible) {
            const label = labelsRef.current.get(district)
            if (!label) return
            label.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`
            label.style.visibility = visible ? 'visible' : 'hidden'
          },
          failed() {
            setStatus('fallback')
            setStage('idle')
            controllerRef.current = null
            // Dispose outside the WebGL event dispatch.
            queueMicrotask(() => controller?.dispose())
          },
        })
        controllerRef.current = controller
        const reduced = window.matchMedia(
          '(prefers-reduced-motion: reduce)'
        ).matches
        setPaused(reduced)
        controller.pause(reduced)
        setStatus('ready')
      } catch {
        if (!cancelled) {
          controller?.dispose()
          setStatus('fallback')
        }
      }
    }
    void load()
    return () => {
      cancelled = true
      controller?.dispose()
      controllerRef.current = null
    }
  }, [attempt, selectDistrict])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setPaused(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const togglePause = () => {
    setPaused((value) => {
      controllerRef.current?.pause(!value)
      return !value
    })
  }
  const sendSpark = () => {
    if (!controllerRef.current || journeyRunning) return
    if (
      paused &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setPaused(false)
      controllerRef.current.pause(false)
    }
    controllerRef.current.journey(selected)
  }
  const resetView = () => {
    selectDistrict('core')
    controllerRef.current?.focus(null)
  }

  return (
    <main
      className='town-experience'
      style={{ '--district-color': color } as CSSProperties}
    >
      <div className='town-atmosphere' aria-hidden='true'>
        <div className='town-nebula town-nebula-one' />
        <div className='town-nebula town-nebula-two' />
        <svg
          className='town-star-chart'
          viewBox='0 0 1440 1000'
          preserveAspectRatio='xMidYMid slice'
        >
          {Array.from({ length: 75 }, (_, i) => (
            <circle
              key={i}
              cx={(i * 137.51) % 1440}
              cy={(i * 97.17) % 1000}
              r={i % 7 === 0 ? 1.6 : 0.7}
              fill='currentColor'
              opacity={0.2 + (i % 4) * 0.15}
            />
          ))}
          <path
            d='M92 181 165 160 197 228 260 248M1141 139l66 24 57-51 45 72M1175 701l50 29 63-30'
            stroke='currentColor'
            strokeOpacity='.13'
            fill='none'
          />
        </svg>
      </div>

      <div className='town-intro'>
        <div className='town-wordmark'>
          <span aria-hidden='true'>✧</span> {t('A universe of possibilities')}{' '}
          <span aria-hidden='true'>✧</span>
        </div>
        <h1>
          {t('Where intelligence')} <br />
          <span>{t('comes to life.')}</span>
        </h1>
        <p>
          {t(
            'Wander through a world of models. Follow your curiosity. Create something extraordinary.'
          )}
        </p>
        <div className='town-intro-actions'>
          <Button
            className='town-primary'
            role='link'
            render={
              <Link to={props.isAuthenticated ? '/dashboard' : '/sign-in'} />
            }
          >
            {props.isAuthenticated ? t('Go to Dashboard') : t('Start creating')}{' '}
            <ArrowUpRight />
          </Button>
          <Button
            variant='ghost'
            role='link'
            className='town-text-button'
            render={<Link to='/pricing' />}
          >
            {t('Explore models')} <span aria-hidden='true'>↗</span>
          </Button>
        </div>
      </div>

      <section
        className='town-observatory'
        aria-label={t('Interactive model world')}
      >
        <div className='town-scene-caption'>
          <span className='town-tiny-star' aria-hidden='true'>
            ✦
          </span>
          <span>{t('Aurora model town')}</span>
          <span className='town-caption-line' />
        </div>
        <div className='town-view-controls' aria-label={t('Scene controls')}>
          <Button
            variant='ghost'
            size='icon'
            aria-label={t('Zoom in')}
            title={t('Zoom in')}
            disabled={status !== 'ready'}
            onClick={() => controllerRef.current?.zoom(1)}
          >
            <Plus />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            aria-label={t('Zoom out')}
            title={t('Zoom out')}
            disabled={status !== 'ready'}
            onClick={() => controllerRef.current?.zoom(-1)}
          >
            <Minus />
          </Button>
          <span className='town-control-divider' />
          <Button
            variant='ghost'
            size='icon'
            aria-label={t('Reset view')}
            title={t('Reset view')}
            disabled={status !== 'ready'}
            onClick={resetView}
          >
            <Maximize2 />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            aria-label={paused ? t('Resume animation') : t('Pause animation')}
            title={paused ? t('Resume animation') : t('Pause animation')}
            aria-pressed={paused}
            disabled={status !== 'ready'}
            onClick={togglePause}
          >
            {paused ? <Play /> : <Pause />}
          </Button>
        </div>

        <div
          className={cn(
            'town-canvas-wrap',
            status === 'ready' && 'town-is-ready'
          )}
        >
          <TownBackdrop />
          <div ref={hostRef} className='town-canvas' />
          <div className='town-labels' aria-hidden={status !== 'ready'}>
            {DISTRICTS.map((district) => (
              <Button
                key={district.id}
                ref={(node) => {
                  if (node) labelsRef.current.set(district.id, node)
                  else labelsRef.current.delete(district.id)
                }}
                variant='ghost'
                className={cn(
                  'town-map-label',
                  selected === district.id && 'town-map-label-active'
                )}
                style={{ '--label-color': district.color } as CSSProperties}
                tabIndex={status === 'ready' ? 0 : -1}
                aria-pressed={selected === district.id}
                onClick={() => selectDistrict(district.id)}
              >
                <span className='town-label-dot' />
                {copy[district.id].name}
                <span aria-hidden='true' className='town-label-plus'>
                  +
                </span>
              </Button>
            ))}
          </div>
        </div>

        <div className='town-scene-hint'>
          <svg
            width='18'
            height='18'
            viewBox='0 0 24 24'
            fill='none'
            aria-hidden='true'
          >
            <path
              d='m4 9 3-3 3 3M7 6v12m7-3 3 3 3-3m-3 3V6'
              stroke='currentColor'
              strokeWidth='1.4'
              strokeLinecap='round'
              strokeLinejoin='round'
            />
          </svg>
          {t('Drag to wander. Select a world to explore.')}
        </div>
        {status === 'loading' && (
          <p className='town-scene-status' role='status'>
            {t('Your little universe is taking shape…')}
          </p>
        )}
        {status === 'fallback' && (
          <div className='town-scene-status town-fallback' role='status'>
            <span>
              {t(
                'Enjoy the illustrated view. Model exploration is still available below.'
              )}
            </span>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCcw />
              {t('Retry interactive view')}
            </Button>
          </div>
        )}
      </section>

      <section
        className='town-explorer'
        aria-label={t('Explore the ecosystem')}
      >
        <div
          className='town-districts'
          role='group'
          aria-label={t('Choose a model district')}
        >
          {DISTRICTS.map((district) => (
            <Button
              key={district.id}
              variant='ghost'
              className={cn(
                'town-district-button',
                selected === district.id && 'town-district-selected'
              )}
              style={{ '--label-color': district.color } as CSSProperties}
              aria-pressed={selected === district.id}
              onClick={() => selectDistrict(district.id)}
            >
              <TownGlyph district={district.id} />
              <span>{copy[district.id].name}</span>
            </Button>
          ))}
        </div>
        <div className='town-detail'>
          <div className='town-detail-glyph'>
            <TownGlyph district={selected} />
          </div>
          <div className='town-detail-copy' aria-live='polite'>
            <h2>{current.kind}</h2>
            <p>{current.description}</p>
          </div>
          <div className='town-journey'>
            <Button
              className='town-spark-button'
              disabled={status !== 'ready' || journeyRunning}
              onClick={sendSpark}
            >
              <Sparkles />
              {journeyRunning ? t('A spark is travelling…') : t('Send a spark')}
            </Button>
            <span className='town-demo-note'>
              {t('An interactive demo. No API usage.')}
            </span>
          </div>
        </div>
        <div className='town-journey-progress' role='status' aria-live='polite'>
          <div className='town-progress-orbit' aria-hidden='true'>
            {(['routing', 'memory', 'generating', 'returning'] as const).map(
              (step) => (
                <span
                  key={step}
                  className={cn(
                    stage === step && 'town-progress-active',
                    stage === 'complete' && 'town-progress-complete'
                  )}
                />
              )
            )}
          </div>
          <span>{journeyCopy[stage]}</span>
        </div>
      </section>
      <div className='town-closing'>
        <span />
        <TownGlyph district='core' />
        <p>{t('Many models. One beautifully connected world.')}</p>
        <span />
      </div>
    </main>
  )
}
