import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import Upload from './pages/Upload.jsx'
import Select from './pages/Select.jsx'
import './App.css'

// Each later stage of the pipeline (cull, group, sequence, songs, render)
// is one more <Route> here plus a file in pages/.
export default function App() {
  return (
    <div className="app">
      <header>
        <h1>Instagram Stories</h1>
        <nav>
          <NavLink to="/upload">Upload</NavLink>
          <NavLink to="/select">Select</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/upload" replace />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/select" element={<Select />} />
          <Route path="*" element={<p>Nothing here.</p>} />
        </Routes>
      </main>
    </div>
  )
}
