import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (!root) throw new Error('no #root')

// The session screen lands here once the core and the adapters exist. Until
// then this mounts nothing rather than a placeholder that looks like product.
createRoot(root).render(<StrictMode />)
