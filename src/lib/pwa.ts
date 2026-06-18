import { registerSW } from 'virtual:pwa-register'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let installPrompt: BeforeInstallPromptEvent | null = null

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e as BeforeInstallPromptEvent
})

export function registerPwa(): void {
  registerSW({ immediate: true })
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return installPrompt
}

export function clearInstallPrompt(): void {
  installPrompt = null
}
