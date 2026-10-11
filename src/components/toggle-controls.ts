import { html, raw, type Safe } from '../utils/dom';
import { t } from '../i18n';

/** A single-select toggle group: connected buttons, the active one filled.
 *  Shared by every toggle row (styled via .toggle-group in settings.css). */
export function toggleGroup(
  id: string,
  options: { value: string; label: string }[],
  active: string,
  disabled: string[] = [],
): Safe {
  return html`
    <div class="toggle-group" id="${id}">
      ${options.map(o => html`
        <button class="toggle-option ${o.value === active ? 'active' : ''}"
                ${raw(disabled.includes(o.value) ? 'disabled' : 'data-focusable')}
                data-key="${id}:${o.value}" data-value="${o.value}">${o.label}</button>
      `)}
    </div>`;
}

export function sourceToggle(enabled: boolean): Safe {
  return html`
    <button class="source-toggle ${enabled ? 'active' : ''}" data-focusable
            data-enabled="${enabled ? 'true' : 'false'}"
            aria-pressed="${enabled ? 'true' : 'false'}">
      <span class="source-toggle-track" aria-hidden="true">
        <span class="source-toggle-knob"></span>
      </span>
      <span class="source-toggle-label">${t(enabled ? 'settings.on' : 'settings.off')}</span>
    </button>`;
}
