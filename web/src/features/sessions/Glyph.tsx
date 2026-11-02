// Status glyph (docs/prototype.html glyph()). Requirement: Статусы сессии — «!» permission, dot unread, ring working,
// grey/red offline.
import type { DisplayStatus } from '../../api/types';
import { STATUS_LABEL } from './status';

export function Glyph({ status, unread, label: text }: { status: DisplayStatus; unread: boolean; label?: string }) {
  // UI review M5: a status icon is an image with the status in words for screen readers
  const label = text ?? (status === 'waiting' && unread ? 'новый ответ' : STATUS_LABEL[status]);
  const props = { role: 'img', 'aria-label': label, title: label };
  if (status === 'offline') return <span className="g-off" {...props} />;
  // `external` (S10.1) has the colour of «работает»
  if (status === 'working' || status === 'external') return <span className="g-work" {...props} />;
  if (status === 'permission')
    return (
      <span className="g-perm" {...props}>
        !
      </span>
    );
  if (status === 'waiting' && unread) return <span className="g-unread" {...props} />;
  if (status === 'sleeping') return <span className="g-sleep" {...props} />;
  return <span className="g-idle" {...props} />;
}
