import type { CSSProperties } from 'react';
import { PROJECT_COLORS, type ProjectColorKey } from '@agent-hub/shared';
import { colorVar } from '../sessions/status';
import { t, useT } from '../../i18n';
export const colorName = (key: ProjectColorKey): string => t(`projects.color.${key}`);
export function ProjectPalette({ value, onChange }: { value: ProjectColorKey; onChange: (value: ProjectColorKey) => void }) {
  useT();
  return (
    <div
      className="project-palette"
      role="radiogroup"
      aria-label={t('projects.palette.label')}
      onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = PROJECT_COLORS.indexOf(value);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 11 : (index + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowUp' ? -6 : event.key === 'ArrowDown' ? 6 : 1) + 12) % 12;
        const color = PROJECT_COLORS[next]!;
        onChange(color);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-color="${color}"]`)?.focus();
      }}
    >
      {PROJECT_COLORS.map(key => (
        <button
          key={key}
          type="button"
          data-color={key}
          tabIndex={value === key ? 0 : -1}
          role="radio"
          className="project-swatch"
          aria-checked={value === key}
          aria-label={colorName(key)}
          title={colorName(key)}
          style={{ '--gc': colorVar(key) } as CSSProperties}
          onClick={() => onChange(key)}
        >
          <span aria-hidden="true">{value === key ? '✓' : ''}</span>
        </button>
      ))}
    </div>
  );
}
