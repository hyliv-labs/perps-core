import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './ui/styles.css'
import './ui/landing.css'
import './ui/session.css'

const root = document.getElementById('root')
if (!root) throw new Error('no #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
