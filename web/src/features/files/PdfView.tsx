/**
 * The PDF view (change tool-windows-file-explorer, task 6.5, design D7). A lazy chunk: pdfjs-dist is not in the main bundle.
 * Page by page on canvas, only the pages near the screen are drawn. Safe settings: no XFA, no scripts (pdfjs 6 has no isEvalSupported option: it never builds fonts with eval),
 * no text layer and no annotation links (they would open addresses from the document); the worker comes from our own origin
 * (CSP `worker-src 'self'`). The bytes come from `fetch().arrayBuffer()`, pdfjs never fetches by itself.
 * Requirement (file-explorer): Просмотрщик — PDF.
 */
import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ViewerEmpty } from './fileViews';

GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  data: ArrayBuffer;
  /** 1 — the page is 520 px wide (320 px on the phone), see `--pz` in files.css. */
  zoom: number;
  onPages: (n: number) => void;
  onPage: (n: number) => void;
}

export default function PdfView({ data, zoom, onPages, onPage }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    setFailed(false);
    // pdfjs hands the buffer to its worker, so it gets a copy: the effect may run again
    const task = getDocument({ data: new Uint8Array(data.slice(0)), enableXfa: false, useSystemFonts: true });
    let gone = false;
    task.promise
      .then(async d => {
        if (gone) return;
        const first = await d.getPage(1);
        const v = first.getViewport({ scale: 1 });
        if (gone) return;
        setRatio(v.height / v.width);
        setDoc(d);
        onPages(d.numPages);
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
      void task.destroy();
    };
    // onPages is a stable setter of the viewer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // the page the reader is on: the one with the largest visible part
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !doc) return;
    const seen = new Map<Element, number>();
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) seen.set(e.target, e.intersectionRatio);
        let best: Element | null = null;
        let max = -1;
        for (const [el, r] of seen) {
          if (r > max) {
            max = r;
            best = el;
          }
        }
        const n = Number((best as HTMLElement | null)?.dataset.page);
        if (n) onPage(n);
      },
      { root: root.parentElement, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    root.querySelectorAll('[data-page]').forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [doc, zoom, onPage]);

  if (failed) return <ViewerEmpty big="Не удалось открыть PDF">Файл повреждён или защищён паролем</ViewerEmpty>;
  return (
    <div className="fx-pdf" style={{ '--pz': zoom } as React.CSSProperties} ref={rootRef} data-testid="pdf-view">
      {doc ? Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} ratio={ratio} zoom={zoom} />) : <div className="fx-note-center">Загрузка…</div>}
    </div>
  );
}

function PdfPage({ doc, n, ratio, zoom }: { doc: PDFDocumentProxy; n: number; ratio: number; zoom: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let task: RenderTask | null = null;
    let gone = false;
    setFailed(false);
    void doc
      .getPage(n)
      .then(page => {
        if (gone) return;
        const base = page.getViewport({ scale: 1 });
        const scale = (el.clientWidth / base.width) * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale });
        cv.width = Math.floor(viewport.width);
        cv.height = Math.floor(viewport.height);
        task = page.render({ canvas: cv, viewport, annotationMode: 0 });
        task.promise.catch(() => undefined);
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
      task?.cancel();
    };
  }, [near, doc, n, zoom]);

  return (
    <div className="fx-pdf-page" ref={box} data-page={n} style={{ aspectRatio: `1 / ${ratio}` }} aria-label={`Страница ${n}`}>
      <canvas ref={canvas} />
      {failed && (
        <div className="fx-note-center" role="alert">
          Не удалось показать страницу {n}
        </div>
      )}
      <div className="pno">{n}</div>
    </div>
  );
}
