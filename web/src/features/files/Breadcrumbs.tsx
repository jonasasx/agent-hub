/**
 * Breadcrumbs of a file: the machine name and the path segments; a click selects the folder in the tree.
 * Markup after docs/prototypes/file-explorer.html (`fileCrumbs`): a path of more than 4 segments is shown as «…» and the
 * last three, the last crumb is the file itself.
 * Requirement (file-explorer): Крошки и действия над файлом.
 */
import { Fragment } from 'react';
import { useT } from '../../i18n';
import { isInside, parentOf, samePath, baseName } from './paths';
import { revealInTree } from './fileActions';

interface Crumb {
  label: string;
  path: string;
}

/** The crumbs below `home` (the whole path from its root when the file lies outside the home folder). */
export function crumbsOf(path: string, home: string | null): Crumb[] {
  const chain: string[] = [];
  for (let p: string | null = path; p; p = parentOf(p)) {
    if (home && samePath(p, home)) break;
    chain.unshift(p);
  }
  // the root of a path outside home (`/`, `C:\`) is not a crumb of its own
  const own = home && isInside(home, path) ? chain : chain.filter(p => parentOf(p) !== null);
  return own.map(p => ({ label: baseName(p), path: p }));
}

interface Props {
  runnerId: string;
  machineName: string;
  path: string;
  home: string | null;
  sessionId?: string;
}

export function Breadcrumbs({ runnerId, machineName, path, home, sessionId }: Props) {
  const t = useT();
  const crumbs = crumbsOf(path, home);
  const start = crumbs.length > 4 ? crumbs.length - 3 : 0;
  const go = (to: string) => revealInTree(runnerId, to, sessionId, true);
  const homePath = home ?? parentOf(crumbs[0]?.path ?? path) ?? path;
  return (
    <nav className="fx-crumbs" aria-label={t('files.crumbs.label')}>
      <button type="button" onClick={() => go(homePath)} title={home ?? machineName}>
        {machineName}
      </button>
      {start > 0 && (
        <>
          <span className="sep">›</span>
          <button type="button" title={crumbs[start - 1]!.path} onClick={() => go(crumbs[start - 1]!.path)}>
            …
          </button>
        </>
      )}
      {crumbs.slice(start).map((c, i, all) => {
        const last = i === all.length - 1;
        return (
          <Fragment key={c.path}>
            <span className="sep">›</span>
            <button type="button" className={last ? 'last' : ''} disabled={last} title={c.path} onClick={() => go(c.path)}>
              {c.label}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
