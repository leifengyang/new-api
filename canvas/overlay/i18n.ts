// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
  convertDetectedLanguage,
  normalizeInterfaceLanguage,
} from './host-languages'
import resources from './translations.json'

function interfaceLanguage(): string {
  let language = navigator.language
  try {
    language = localStorage.getItem('i18nextLng') || language
  } catch {
    /* Browser storage may be unavailable. */
  }
  const detected = convertDetectedLanguage(language)
  return normalizeInterfaceLanguage(
    detected.startsWith('zh') ? detected : detected.split('-')[0]
  )
}

export async function initializeCanvasTranslations(): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources,
    lng: interfaceLanguage(),
    fallbackLng: 'en',
    supportedLngs: Object.keys(resources),
    load: 'currentOnly',
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
  })
  // Same-origin storage events also reach the frame when the host changes language.
  window.addEventListener('storage', (event) => {
    if (event.key === 'i18nextLng' || event.key === null) {
      void i18n.changeLanguage(interfaceLanguage())
    }
  })
}
