import { useState } from 'react'

// Files go up one request each: a batch id first, then raw bytes per file.
// Sequential on purpose — 200 parallel requests starve the single-threaded
// dev server. ponytail: batch into ~4 at a time if 200 photos feels slow.
async function uploadAll(files, onProgress) {
  const res = await fetch('/api/batch', { method: 'POST' })
  if (!res.ok) throw new Error('could not start a batch')
  const { batch } = await res.json()

  const failed = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    try {
      const r = await fetch(
        `/api/upload?batch=${batch}&name=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: file },
      )
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({}))
        failed.push({ name: file.name, error: error || `HTTP ${r.status}` })
      }
    } catch (e) {
      failed.push({ name: file.name, error: e.message })
    }
    onProgress(i + 1, files.length)
  }
  return { batch, failed }
}

export default function Upload() {
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState([0, 0])

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const result = await uploadAll(files, (n, total) => setProgress([n, total]))
      setDone(result)
      setFiles([])
      e.target.reset()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>Upload photos</h2>
      <p className="muted">
        Everything from one trip or one night. JPG, PNG, HEIC or WebP.
      </p>

      <label htmlFor="photos">Choose photos</label>
      <input
        id="photos"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,.heic,.heif"
        disabled={busy}
        onChange={(e) => {
          setFiles([...e.target.files])
          setDone(null)
        }}
      />

      {files.length > 0 && (
        <p>
          {files.length} selected ·{' '}
          {(files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)} MB
        </p>
      )}

      <button type="submit" disabled={busy || files.length === 0}>
        {busy ? `Uploading ${progress[0]}/${progress[1]}…` : 'Upload'}
      </button>

      {error && <p className="error">Upload failed: {error}</p>}

      {done && (
        <div className="result">
          <p>
            Saved {progress[1] - done.failed.length} of {progress[1]} to batch{' '}
            <code>{done.batch}</code>
          </p>
          {done.failed.length > 0 && (
            <ul className="error">
              {done.failed.map((f) => (
                <li key={f.name}>
                  {f.name} — {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  )
}
