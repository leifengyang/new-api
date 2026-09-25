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
import { fireEvent, screen } from '@testing-library/react'

/**
 * The details dialog keeps its identifying and diagnostic sections inside a
 * panel that is collapsed by default, so the billing summary owns the first
 * screen. A test asserting on any of those sections opens the panel first, the
 * way a reader would.
 */
export function expandTechnicalDetails(): void {
  fireEvent.click(screen.getByRole('button', { name: /Technical details/ }))
}
