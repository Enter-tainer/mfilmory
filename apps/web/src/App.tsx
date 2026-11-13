import { useEffect } from 'react'
import { Outlet } from 'react-router'

import { useCommandPaletteShortcut } from './hooks/useCommandPaletteShortcut'
import { scheduleViewerRoutePrefetch } from './lib/prefetch-viewer'
import { CommandPalette } from './modules/cmdk/CommandPalette'
import { RootProviders } from './providers/root-providers'

function App() {
  useEffect(() => scheduleViewerRoutePrefetch(), [])

  return (
    <RootProviders>
      <div className="overflow-hidden lg:h-svh">
        <Outlet />
        <CommandPaletteContainer />
      </div>
    </RootProviders>
  )
}

const CommandPaletteContainer = () => {
  const { isOpen, setIsOpen } = useCommandPaletteShortcut()
  return <CommandPalette isOpen={isOpen} onClose={() => setIsOpen(false)} />
}
export default App
