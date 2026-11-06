/**
 * The body of the «Машины» window: chips of the machines (the data of the old footer) with a menu each
 * (Requirement «Окно „Машины“»; docs/prototypes/tool-windows.html machinesBody).
 */
import { useT } from '../../i18n';
import { usableRunner, useStore } from '../../store';
import { MachineChip } from './MachineMenu';

export function MachinesWindow() {
  const t = useT();
  const runners = useStore(s => s.runners);
  const list = runners.filter(usableRunner);
  if (!list.length) return <p className="hint">{t('machines.window.empty')}</p>;
  return (
    <div className="tw-mline" role="list" aria-label={t('machines.window.label')}>
      {list.map(r => (
        <span key={r.id} role="listitem" className="tw-pop">
          <MachineChip r={r} />
        </span>
      ))}
    </div>
  );
}
