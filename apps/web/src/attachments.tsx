import { useEffect, useRef, useState } from 'react';
import type { Artifact } from '../../../packages/protocol/src/index.ts';

function ImageLightbox({artifact, previewFailed, onClose}: {artifact: Artifact; previewFailed: boolean; onClose: () => void}) {
  const closeRef = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); returnFocus.current?.focus?.(); };
  }, [onClose]);
  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`图片：${artifact.image?.alt || artifact.name}`} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-lightbox-body">
      <header><strong>{artifact.image?.alt || artifact.name}</strong><small>{artifact.image?.width} × {artifact.image?.height} · {artifact.mediaType}</small><button ref={closeRef} type="button" className="button small" onClick={onClose}>关闭</button></header>
      {previewFailed ? <p className="muted">预览不可用，但仍可下载原图。</p> : <img src={`/api/artifacts/${encodeURIComponent(artifact.id)}/image`} alt={artifact.image?.alt || artifact.name} width={artifact.image?.width} height={artifact.image?.height}/>}
      <footer><a className="button" href={`/api/artifacts/${encodeURIComponent(artifact.id)}`} download={artifact.name}>下载原图</a><button type="button" className="button" onClick={onClose}>关闭</button></footer>
    </div>
  </div>;
}

/**
 * Renders message attachments. Verified images become bounded thumbnails with
 * previews fetched from the private same-origin route; every other artifact
 * keeps the existing file/report action.
 */
export function MessageAttachments({artifactIds, artifacts, onOpenArtifact}: {artifactIds: string[]; artifacts: Artifact[]; onOpenArtifact: (artifact: Artifact) => void}) {
  const [lightbox, setLightbox] = useState<Artifact>();
  const [failedPreviews, setFailedPreviews] = useState<Record<string, true>>({});
  if (!artifactIds.length) return null;
  return <div className="message-attachments">
    {artifactIds.map(id => {
      const artifact = artifacts.find(item => item.id === id);
      if (!artifact) return <span className="attachment attachment-missing" key={id}>附件 {id}</span>;
      const isImage = artifact.image?.verified === true;
      const failed = failedPreviews[id] === true;
      if (!isImage || failed) {
        return <button key={id} type="button" className="attachment" onClick={() => onOpenArtifact(artifact)}>
          <span>{isImage ? '预览不可用 · ' : ''}{artifact.name}</span><small>{artifact.mediaType} · 下载</small>
        </button>;
      }
      return <button key={id} type="button" className="attachment-image-button" aria-label={`查看图片 ${artifact.image?.alt || artifact.name}`} onClick={() => setLightbox(artifact)}>
        <img className="attachment-thumb" src={`/api/artifacts/${encodeURIComponent(artifact.id)}/image`} alt={artifact.image?.alt || artifact.name} width={artifact.image?.width} height={artifact.image?.height} loading="lazy" decoding="async" onError={() => setFailedPreviews(previous => ({...previous, [id]: true}))}/>
        <span>{artifact.image?.alt || artifact.name}</span>
      </button>;
    })}
    {lightbox && <ImageLightbox artifact={lightbox} previewFailed={failedPreviews[lightbox.id] === true} onClose={() => setLightbox(undefined)}/>}
  </div>;
}
