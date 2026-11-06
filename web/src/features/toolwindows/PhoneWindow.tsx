/**
 * A tool window on the phone: full screen over the home screen with «←» back to it (Requirement «Телефон»). The browser
 * Back button does the same through `phoneHistory`.
 */
import { backFromWindow } from '../workspace/phoneHistory';
import { WINDOWS } from './windows';
import { IconBack } from './icons';
import { useDock } from './useDock';
import { usePhone } from './usePhone';

export function PhoneWindow() {
  const phone = usePhone();
  const id = useDock(s => s.phoneWin);
  if (!phone || !id) return null;
  const def = WINDOWS[id];
  const { Body } = def;
  return (
    <section className="tw-phone" data-id={id} aria-label={def.title}>
      <div className="tw-head">
        <button type="button" className="tw-hbtn tw-back" aria-label="Назад" title="Назад" onClick={backFromWindow}>
          {IconBack}
        </button>
        <span className="tw-title">{def.title}</span>
        {def.actions().map(a => (
          <button key={a.title} type="button" className="tw-hbtn" title={a.title} aria-label={a.title} onClick={a.run}>
            {a.icon}
          </button>
        ))}
      </div>
      <div className="tw-body">
        <Body />
      </div>
    </section>
  );
}
