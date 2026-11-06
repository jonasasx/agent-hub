/**
 * The link between the file explorer and the tool-window host (change tool-windows-file-explorer, tasks 6.7/4.x).
 * The host (App panels) registers the function that shows the «Файлы» window — restoring it when it is hidden — and
 * the explorer calls it from the chat header, the «Машины» block and the file crumbs.
 */
export let openFilesWindow: () => void = () => {};

export function setOpenFilesWindow(fn: () => void): void {
  openFilesWindow = fn;
}
