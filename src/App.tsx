import { useEffect } from 'react'
import { useUIStore } from './stores/uiStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useAutoSave } from './hooks/useAutoSave'
import { opfsManager } from './lib/opfs/OPFSManager'
import { Topbar } from './components/layout/Topbar'
import { LibraryView } from './components/library/LibraryView'
import { EditView } from './components/edit/EditView'
import './App.css'

export function App() {
  const view = useUIStore((s) => s.view)
  const error = useUIStore((s) => s.error)
  const setError = useUIStore((s) => s.setError)

  useKeyboardShortcuts()
  useAutoSave()

  useEffect(() => {
    opfsManager.init().catch((err) => {
      console.error('OPFS init failed:', err)
    })
  }, [])

  return (
    <div className="app-shell">
      <div className="mobile-notice">
        <h1>Rawesome</h1>
        <p>Rawesome is a desktop browser application and isn't currently available on mobile devices.</p>
        <p>Please visit on a desktop computer to edit your RAW photos.</p>
      </div>
      <Topbar />
      {view === 'library' ? <LibraryView /> : <EditView />}
      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          <span>{error}</span>
          <button>&times;</button>
        </div>
      )}
    </div>
  )
}
