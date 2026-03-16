import { useEffect, useState } from 'react'
import type { CatalogEntry, FileId } from '../../types'
import { opfsManager } from '../../lib/opfs/OPFSManager'
import './ThumbnailGrid.css'

interface ThumbnailGridProps {
  entries: CatalogEntry[]
  onOpen: (id: FileId) => void
  onDelete: (id: FileId) => void
}

export function ThumbnailGrid({ entries, onOpen, onDelete }: ThumbnailGridProps) {
  if (entries.length === 0) {
    return (
      <div className="thumbnail-grid__empty">
        <div className="thumbnail-grid__hero">
          <h1 className="thumbnail-grid__title">Raw Dog</h1>
          <p className="thumbnail-grid__tagline">
            A browser-based RAW photo editor. No uploads, no accounts, no server — your photos never leave your machine.
          </p>
        </div>

        <div className="thumbnail-grid__features">
          <div className="thumbnail-grid__feature">
            <span className="thumbnail-grid__feature-icon">&#x1f4f7;</span>
            <h3>RAW Format Support</h3>
            <p>CR2, NEF, ARW, DNG, RAF, ORF, and more. Open files straight from your camera.</p>
          </div>
          <div className="thumbnail-grid__feature">
            <span className="thumbnail-grid__feature-icon">&#x1f3a8;</span>
            <h3>Non-Destructive Editing</h3>
            <p>Exposure, white balance, contrast, clarity, HSL, crop, and film simulations — with full undo/redo.</p>
          </div>
          <div className="thumbnail-grid__feature">
            <span className="thumbnail-grid__feature-icon">&#x26a1;</span>
            <h3>GPU-Accelerated</h3>
            <p>Real-time WebGL2 rendering pipeline. Adjustments update instantly, even on large files.</p>
          </div>
          <div className="thumbnail-grid__feature">
            <span className="thumbnail-grid__feature-icon">&#x1f512;</span>
            <h3>Completely Private</h3>
            <p>Everything runs client-side. Files are stored in your browser — nothing is sent anywhere.</p>
          </div>
        </div>

        <p className="thumbnail-grid__cta">
          Drag and drop RAW files or click <strong>Import RAW Files</strong> to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="thumbnail-grid">
      {entries.map((entry) => (
        <ThumbnailCard key={entry.id} entry={entry} onOpen={onOpen} onDelete={onDelete} />
      ))}
    </div>
  )
}

function ThumbnailCard({ entry, onOpen, onDelete }: {
  entry: CatalogEntry
  onOpen: (id: FileId) => void
  onDelete: (id: FileId) => void
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoke: string | null = null
    if (entry.thumbnailReady) {
      opfsManager.readThumbnailURL(entry.id).then((url) => {
        if (url) {
          revoke = url
          setThumbUrl(url)
        }
      })
    }
    return () => {
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [entry.id, entry.thumbnailReady])

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(entry.id)
  }

  return (
    <div className="thumbnail-card" onClick={() => onOpen(entry.id)}>
      <div className="thumbnail-card__image">
        {thumbUrl ? (
          <img src={thumbUrl} alt={entry.originalName} />
        ) : (
          <div className="thumbnail-card__placeholder">
            {entry.thumbnailReady ? 'Loading...' : 'Processing...'}
          </div>
        )}
      </div>
      <div className="thumbnail-card__info">
        <span className="thumbnail-card__name" title={entry.originalName}>
          {entry.originalName}
        </span>
        <button className="thumbnail-card__delete" onClick={handleDelete} aria-label="Delete">
          &times;
        </button>
      </div>
    </div>
  )
}
