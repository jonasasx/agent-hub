/**
 * «Импортировать MCP» on the machine page (change `mcp-hub-only`, D9): the same preview as the enrollment step, in a modal.
 * Requirement (machine-mcp-onboarding): Повторный импорт со страницы машины.
 */
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { McpImportCommitResponse } from '../../api/mcpRegistryTypes';
import { useT } from '../../i18n';
import { useDialog } from '../ui/a11y';
import { McpImportPanel } from './McpImportPanel';

export function McpImportDialog({
  machineId,
  machineName,
  onClose,
  onImported,
}: {
  machineId: string;
  machineName: string;
  onClose: () => void;
  onImported?: (result: McpImportCommitResponse) => void;
}) {
  const t = useT();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  return createPortal(
    <div className="scrim modal-top" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="modal mcp-import-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
        <div className="modal-head">
          <h2 id={titleId}>{t('mcp.import.dialogTitle', { name: machineName })}</h2>
          <p>{t('mcp.import.dialogLead')}</p>
        </div>
        <div className="modal-body">
          <McpImportPanel machineId={machineId} onClose={onClose} onImported={onImported} skipLabel={t('mcp.import.cancel')} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
