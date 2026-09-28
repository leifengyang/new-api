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
import { Code2, Layers3, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { HeroTerminalDemo } from './hero-terminal-demo'

export function SimpleHome(props: { isAuthenticated: boolean }) {
  const { t } = useTranslation()

  return (
    <main id='main-content' className='simple-home-main'>
      <section className='simple-home-hero' aria-labelledby='home-heading'>
        <div className='simple-home-copy'>
          <h1 id='home-heading'>{t('Good ideas.\nA simpler start.')}</h1>
          <p className='simple-home-description'>
            {t(
              'Connect to leading AI models with one API. Give your next idea a little more room.'
            )}
          </p>
          <div className='simple-home-actions'>
            <Button
              size='lg'
              role='link'
              render={
                <Link to={props.isAuthenticated ? '/dashboard' : '/sign-in'} />
              }
            >
              {props.isAuthenticated
                ? t('Go to Dashboard')
                : t('Start creating')}
            </Button>
            <Button
              variant='outline'
              role='link'
              size='lg'
              render={<Link to='/pricing' />}
            >
              {t('Explore models')}
            </Button>
          </div>
          <p className='simple-home-compatibility'>
            <Code2 aria-hidden='true' />
            {t('Works with the OpenAI SDK')}
          </p>
        </div>

        {/* Kept after the copy column so the primary action stays the first
            focusable element on the page; the card's own tab strip follows it. */}
        <HeroTerminalDemo className='simple-home-terminal' />
      </section>

      <section
        className='simple-home-models'
        aria-label={t('AI model ecosystem')}
      >
        <p>{t('Many models. A familiar way to build.')}</p>
        <ul>
          <li>OpenAI</li>
          <li>Claude</li>
          <li>Gemini</li>
          <li>DeepSeek</li>
          <li>Qwen</li>
        </ul>
      </section>

      <section
        className='simple-home-details'
        aria-label={t('Built for your workflow')}
      >
        <article>
          <Code2 aria-hidden='true' />
          <h2>{t('Keep your workflow')}</h2>
          <p>
            {t('Use familiar SDKs and tools. Spend less time on integration.')}
          </p>
        </article>
        <article>
          <Layers3 aria-hidden='true' />
          <h2>{t('Find your model')}</h2>
          <p>
            {t(
              'Explore models for writing, coding, and visual ideas in one place.'
            )}
          </p>
        </article>
        <article>
          <SlidersHorizontal aria-hidden='true' />
          <h2>{t('Stay in control')}</h2>
          <p>
            {t('Manage API keys and see your usage clearly in the console.')}
          </p>
        </article>
      </section>
    </main>
  )
}
