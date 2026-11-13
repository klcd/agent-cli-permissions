export function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function copyText(text: string, btn?: HTMLElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    if (btn) {
      const prev = btn.textContent
      btn.textContent = 'Copied'
      setTimeout(() => {
        btn.textContent = prev
      }, 1000)
    }
  } catch {}
}
