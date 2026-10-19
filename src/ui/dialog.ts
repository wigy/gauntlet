import './dialog.css';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Label of the confirming button, e.g. "Delete level". */
  confirm: string;
  cancel?: string;
  /** Destructive action: red confirm button, and Cancel has the initial focus so a stray Enter is harmless. */
  danger?: boolean;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let current: Promise<boolean> | null = null;

/**
 * A themed replacement for window.confirm(). Resolves true when confirmed, false on Cancel, Escape or a click
 * outside. While it's open it swallows keyboard input, so shortcuts underneath don't fire.
 */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  if (current) return current.then(() => confirmDialog(o));
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const backdrop = document.createElement('div');
  backdrop.className = 'dlg-backdrop';
  backdrop.innerHTML = `
    <div class="dlg ${o.danger ? 'danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" ${o.message ? 'aria-describedby="dlg-msg"' : ''}>
      <div class="dlg-icon" aria-hidden="true">${o.danger ? '!' : '?'}</div>
      <h2 id="dlg-title">${esc(o.title)}</h2>
      ${o.message ? `<p id="dlg-msg">${esc(o.message)}</p>` : ''}
      <div class="dlg-buttons">
        <button type="button" class="dlg-btn" data-answer="no">${esc(o.cancel ?? 'Cancel')}</button>
        <button type="button" class="dlg-btn ${o.danger ? 'danger' : 'primary'}" data-answer="yes">${esc(o.confirm)}</button>
      </div>
    </div>`;
  document.body.append(backdrop);
  const buttons = [...backdrop.querySelectorAll<HTMLButtonElement>('button')];
  (o.danger ? buttons[0] : buttons[1]).focus();
  requestAnimationFrame(() => backdrop.classList.add('show'));

  current = new Promise<boolean>((resolve) => {
    const finish = (answer: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('show');
      backdrop.classList.add('hide');
      setTimeout(() => backdrop.remove(), 160);
      previous?.focus();
      current = null;
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(document.activeElement === buttons[0] ? false : true);
      } else if (e.key === 'Tab') {
        // Keep focus on the two buttons.
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(false);
    });
    for (const b of buttons) b.addEventListener('click', () => finish(b.dataset.answer === 'yes'));
  });
  return current;
}
