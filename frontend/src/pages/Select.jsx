import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

// Placeholder. The real thing is the cull/resolve pass: swipe each photo
// cut/edit/keep, then resolve near-duplicate groups down to survivors.
//
// ponytail: lists the batch from the server rather than showing the photos —
// there is no GET for image bytes yet. Add one when this page renders tiles.
export default function Select() {
  const [params] = useSearchParams()
  const batch = params.get('batch')
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!batch) return
    let live = true
    fetch(`/api/batch/${encodeURIComponent(batch)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`server said ${r.status}`))))
      .then((d) => live && setInfo(d))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [batch])

  return (
    <section className="intro">
      <h2>Photo selection</h2>
      <p>
        Not built yet. This is where you&apos;ll cull the batch — keep, cut, or flag
        for editing — and pick a survivor from each set of near-duplicates.
      </p>
      <p style={{ marginTop: 'var(--s4)' }}>
        {!batch
          ? 'No batch chosen. Upload some photos first.'
          : error
            ? `Couldn't read batch ${batch} — ${error}`
            : info
              ? `Batch ${batch} holds ${info.count} ${info.count === 1 ? 'photo' : 'photos'}.`
              : `Reading batch ${batch}…`}
      </p>
      <p style={{ marginTop: 'var(--s5)' }}>
        <Link to="/upload">Back to upload</Link>
      </p>
    </section>
  )
}
