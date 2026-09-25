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
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

/**
 * Shown on the sign-up route when registration is invite-only and this visit
 * carries no invitation credential. Deliberately renders no form and no
 * third-party registration entry: the visitor has nothing to submit here.
 */
export function RegistrationRestricted() {
  const { t } = useTranslation()

  return (
    <EmptyState
      icon={Lock}
      title={t('Invite-Only Registration')}
      description={t(
        'Internal platform, not open to the public. Registration is not permitted.'
      )}
      action={<Button render={<Link to='/sign-in' />}>{t('Sign in')}</Button>}
    />
  )
}
