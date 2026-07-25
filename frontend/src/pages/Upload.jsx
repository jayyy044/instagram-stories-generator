import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import './Upload.css'

// Mirrors ALLOWED_EXT in backend/server.py. Anything else is a guaranteed 400,
// so it gets caught here instead of spending a round trip to be told no.
const IMAGE_RE = /\.(jpe?g|png|heic|heif|webp)$/i
const TILE_CAP = 24
// Stable identity, so the object-URL effect doesn't re-run on every render
// just because a fresh [] was allocated.
const EMPTY = []

const idOf = (f) => `${f.name}|${f.size}|${f.lastModified}`
const photos = (n) => (n === 1 ? '1 photo' : `${n} photos`)

// Camera JPGs are megabytes, but a test folder of thumbnails is not — plain
// toFixed(1) on MB renders every one of them as a flat "0.0 MB".
const size = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

async function createBatch() {
  const res = await fetch('/api/batch', { method: 'POST' })
  if (!res.ok) throw new Error(`server said ${res.status}`)
  const { batch } = await res.json()
  if (!batch) throw new Error('no batch id in the response')
  return batch
}

// One request per file, raw body, no multipart — see backend/server.py.
async function putFile(batch, file) {
  let res
  try {
    res = await fetch(
      `/api/upload?batch=${encodeURIComponent(batch)}&name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    )
  } catch (err) {
    // TypeError is the network layer giving up on the whole connection.
    // NotReadableError and friends mean this one file moved or vanished
    // between the picker handing it over and us reading it.
    if (err && err.name === 'TypeError') {
      const stop = new Error('connection lost')
      stop.network = true
      throw stop
    }
    throw new Error("couldn't read this file")
  }
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || `server said ${res.status}`)
  }
}

const PhotoIcon = () => (
  <svg
    className="dz-icon"
    width="40"
    height="40"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="6.5" y="6.5" width="14" height="12" rx="2.5" />
    <path d="M3.5 15.5V5.5A2 2 0 0 1 5.5 3.5h10" />
    <circle cx="10.5" cy="10.5" r="1.5" />
    <path d="M20.5 15l-3.8-3.6a1.6 1.6 0 0 0-2.2 0L7.2 18.5" />
  </svg>
)

const CheckIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6.5 9.2 17.5 4 12.3" />
  </svg>
)

const AlertIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <path d="M12 16.4h.01" />
  </svg>
)

const CrossIcon = ({ size, weight }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={weight}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export default function Upload() {
  const [files, setFiles] = useState([])
  const [urls, setUrls] = useState(() => new Map())
  // Keyed on the File object, not the index — removing a file mid-list would
  // slide every index along and repaint the wrong tiles.
  const [states, setStates] = useState(() => new Map())
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [showFailed, setShowFailed] = useState(false)
  const [progress, setProgress] = useState({ n: 0, total: 0 })
  const [result, setResult] = useState(null)
  const [hardError, setHardError] = useState(null)
  const [live, setLive] = useState('')
  // What actually landed on the server, accumulated across retries and second
  // helpings. Once this is non-empty the page is a gallery, not a dropzone.
  const [uploaded, setUploaded] = useState(null)

  // Only the delta churns. Rebuilding the whole map on every selection change
  // would revoke all 200 blob URLs and mint 201 to add one photo, forcing every
  // visible <img> to reload.
  //
  // The map lives in a ref, not in state: createObjectURL inside a state
  // updater runs twice under StrictMode and leaks a URL per file, because React
  // requires updaters to be pure. An effect body is the honest place for a side
  // effect, and re-running it is idempotent against the ref.
  const kept = uploaded ? uploaded.files : EMPTY
  const urlsRef = useRef(new Map())
  useEffect(() => {
    const prev = urlsRef.current
    const next = new Map()
    for (const f of [...files, ...kept]) {
      next.set(f, prev.get(f) ?? URL.createObjectURL(f))
    }
    for (const [f, url] of prev) if (!next.has(f)) URL.revokeObjectURL(url)
    urlsRef.current = next
    setUrls(next)
  }, [files, kept])

  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url)
      urlsRef.current = new Map()
    },
    [],
  )

  // A drop that misses the zone otherwise navigates the tab to the image.
  useEffect(() => {
    const stop = (e) => e.preventDefault()
    document.addEventListener('dragover', stop)
    document.addEventListener('drop', stop)
    return () => {
      document.removeEventListener('dragover', stop)
      document.removeEventListener('drop', stop)
    }
  }, [])

  function addFiles(incoming) {
    const list = [...incoming]
    if (list.length === 0) return
    const images = list.filter((f) => IMAGE_RE.test(f.name))
    const skipped = list.filter((f) => !IMAGE_RE.test(f.name))

    if (images.length > 0) {
      setFiles((prev) => {
        const seen = new Set(prev.map(idOf))
        const add = []
        for (const f of images) {
          const id = idOf(f)
          if (seen.has(id)) continue
          seen.add(id)
          add.push(f)
        }
        // Same array back when nothing is new, so the object-URL effect,
        // which is keyed on `files`, does not churn 200 blobs for nothing.
        return add.length ? [...prev, ...add] : prev
      })
      // A fresh selection means a fresh batch; the old panel and the old
      // failure badges no longer describe what is on screen.
      setResult(null)
      setStates(new Map())
    }

    const names = skipped.map((f) => f.name).join(' · ')
    if (skipped.length === 0) setHardError(null)
    else if (images.length === 0)
      setHardError({ message: "Nothing to add — those weren't images", detail: names })
    else if (skipped.length === 1)
      setHardError({ message: `${skipped[0].name} — not a supported image` })
    else
      setHardError({
        message: `Skipped ${skipped.length} files that aren't images`,
        detail: names,
      })
  }

  function removeFile(file) {
    setFiles((prev) => prev.filter((f) => f !== file))
    setStates((prev) => {
      const next = new Map(prev)
      next.delete(file)
      return next
    })
    setResult((prev) => {
      if (!prev) return prev
      const failed = prev.failed.filter((x) => x.file !== file)
      return failed.length ? { ...prev, failed } : null
    })
  }

  function clearAll() {
    setFiles([])
    setStates(new Map())
    setResult(null)
    setHardError(null)
    setExpanded(false)
  }

  // Drops the gallery and the batch id. The files stay on the server — this
  // only walks away from them, it does not delete anything.
  function startOver() {
    clearAll()
    setUploaded(null)
  }

  async function runUpload(batch, list, isRetry) {
    const total = list.length
    setProgress({ n: 0, total })
    setStates(new Map(list.map((f) => [f, { status: 'pending' }])))
    setLive(`Uploading ${photos(total)}`)

    const failed = []
    let n = 0
    let stopped = false

    // Sequential on purpose: 200 parallel requests starve the single-threaded
    // dev server, and the UI has nothing better to report than file n of N.
    for (const file of list) {
      setStates((prev) => new Map(prev).set(file, { status: 'uploading' }))
      try {
        await putFile(batch, file)
        setStates((prev) => new Map(prev).set(file, { status: 'done' }))
      } catch (err) {
        if (err.network) {
          stopped = true
          break
        }
        failed.push({ file, reason: err.message })
        setStates((prev) => new Map(prev).set(file, { status: 'failed', reason: err.message }))
      }
      n += 1
      setProgress({ n, total })
      // Announcing all 200 steps makes a screen reader unusable — 10% only.
      if (Math.floor((n * 10) / total) !== Math.floor(((n - 1) * 10) / total)) {
        setLive(`${n} of ${total} uploaded`)
      }
    }

    // The one that broke plus everything after it never landed.
    if (stopped) for (const file of list.slice(n)) failed.push({ file, reason: 'not uploaded' })

    const ok = total - failed.length
    // Everything that wasn't in the failed list made it to disk.
    const bad = new Set(failed.map((f) => f.file))
    const landed = list.filter((f) => !bad.has(f))
    setUploaded((prev) => ({
      batch,
      files: prev && prev.batch === batch ? [...prev.files, ...landed] : landed,
    }))
    // Grid clears on a clean run, persists filtered to failures otherwise.
    setFiles(failed.map((f) => f.file))
    setStates(new Map(failed.map((f) => [f.file, { status: 'failed', reason: f.reason }])))
    setResult({ batch, total, ok, failed, stopped, isRetry })
    setShowFailed(false)
    setLive(
      failed.length === 0
        ? `All ${photos(total)} uploaded`
        : `${ok} of ${total} photos uploaded. ${failed.length} failed.`,
    )
  }

  async function submit(e) {
    e.preventDefault()
    if (files.length === 0) {
      setHardError({ message: 'Choose some photos first' })
      return
    }
    setHardError(null)
    setResult(null)
    setBusy(true)
    try {
      let batch
      try {
        // A second helping belongs to the same trip, so it lands in the same
        // batch directory. Minting a new id here would orphan the first one.
        batch = uploaded ? uploaded.batch : await createBatch()
      } catch (err) {
        setHardError({
          message: "Couldn't start the upload",
          detail:
            "The server didn't respond. Check that the backend is running and try again.",
          raw: err.message,
        })
        return // the finally below still clears busy
      }
      await runUpload(batch, files, false)
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    // The batch directory already exists on disk — reuse the id so the retried
    // files land beside the ones that made it the first time.
    if (!result || files.length === 0) return
    setHardError(null)
    setBusy(true)
    try {
      await runUpload(result.batch, files, true)
    } finally {
      setBusy(false)
    }
  }

  const total = files.length
  const bytes = files.reduce((n, f) => n + f.size, 0)
  const isExpanded = expanded && total > TILE_CAP
  const collapsed = total > TILE_CAP && !expanded
  const visible = collapsed ? files.slice(0, TILE_CAP - 1) : files
  const pct = progress.total ? Math.round((progress.n / progress.total) * 100) : 0

  const done = uploaded ? uploaded.files : EMPTY
  // The zone is the hero only on an empty page. With photos on screen it is a
  // secondary action, so it becomes a normal button and the photos take the top.
  const hero = total === 0 && done.length === 0

  const dz = busy
    ? { head: 'Uploading…', sub: 'Keep this tab open until it finishes' }
    : dragging
      ? { head: 'Drop to add photos', sub: 'JPG, PNG, HEIC or WebP' }
      : hero
        ? { head: 'Drop photos here', sub: 'or click to browse — JPG, PNG, HEIC or WebP' }
        : { head: 'Add more photos', sub: 'Drop them here or click to browse' }

  // One element, two placements: hero block, or a button in the action row.
  const picker = (
    <label className={`dropzone${hero ? '' : ' is-compact'}${busy ? ' is-busy' : ''}`}>
      {/* A real <label> around a clipped input: click-to-browse and Enter/Space
          both come free from the platform, no keyboard handler needed. */}
      <input
        className="sr-only dz-input"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.heic,.heif,.webp"
        disabled={busy}
        aria-label="Choose photos to upload"
        aria-describedby={hero ? 'dz-hint' : undefined}
        onChange={(e) => {
          addFiles(e.target.files)
          // Selections accumulate, so the input must not hold the last one:
          // clearing it lets the same file fire change again after a remove.
          e.target.value = ''
        }}
      />
      <PhotoIcon />
      <span className="dz-headline">{dz.head}</span>
      {hero && (
        <span className="dz-sub" id="dz-hint">
          {dz.sub}
        </span>
      )}
    </label>
  )

  return (
    <form
      className={`upload${dragging ? ' is-drag' : ''}`}
      onSubmit={submit}
      // On the form, not the zone: once photos exist the zone is a small button
      // in the action row, and a drop anywhere on the page should still land.
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault()
        if (!busy) setDragging(true)
      }}
      onDragLeave={(e) => {
        // Crossing a child element fires leave; ignore those or it flickers.
        if (e.currentTarget.contains(e.relatedTarget)) return
        setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!busy) addFiles(e.dataTransfer.files)
      }}
    >
      <section className="intro">
        <h2>{done.length > 0 ? 'Your photos' : 'Upload photos'}</h2>
        <p>
          {done.length > 0
            ? 'These are on the server. Add more, or move on to culling.'
            : "Everything from one trip or one night. We'll cull the duplicates and cut them into stories."}
        </p>
      </section>

      {done.length > 0 && (
        <section className="uploaded">
          <div className="summary">
            <span>
              <b>{done.length}</b> {done.length === 1 ? 'photo' : 'photos'} uploaded ·{' '}
              <code>{uploaded.batch}</code>
            </span>
            {!busy && (
              <button type="button" className="btn-text" onClick={startOver}>
                Start over
              </button>
            )}
          </div>
          <ul className="grid">
            {done.map((file) => (
              <li className="tile" key={idOf(file)} title={file.name}>
                <img src={urls.get(file)} alt="" loading="lazy" decoding="async" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Hero only while there is nothing to look at. Once photos exist they
          take this slot and the zone moves into the action row as a button. */}
      {hero && picker}

      {total > 0 && (
        <section className={`selection${busy ? ' is-busy' : ''}`}>
          <div className="summary">
            <span>
              <b>{total}</b> {total === 1 ? 'photo' : 'photos'} · {size(bytes)}
            </span>
            {!busy && (
              <button type="button" className="btn-text" onClick={clearAll}>
                Clear all
              </button>
            )}
          </div>

          <div className={`grid-scroll${isExpanded ? ' is-expanded' : ''}`}>
            <ul className="grid">
              {visible.map((file) => {
                const st = states.get(file)
                const failed = st && st.status === 'failed'
                return (
                  <li
                    key={idOf(file)}
                    className={`tile${st ? ` is-${st.status}` : ''}`}
                    title={file.name}
                    aria-label={failed ? `${file.name} — ${st.reason}` : undefined}
                  >
                    <img src={urls.get(file)} alt="" loading="lazy" decoding="async" />
                    {failed && (
                      <span className="tile-badge">
                        <CrossIcon size={10} weight={3.5} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="tile-remove"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => removeFile(file)}
                    >
                      <CrossIcon size={11} weight={2.5} />
                    </button>
                  </li>
                )
              })}
              {/* One control, two presentations. It must stay mounted across
                  the toggle: unmounting it drops focus to <body> and throws a
                  keyboard user back to the top of the page. */}
              {total > TILE_CAP && (
                <li className="counter-cell">
                  <button
                    type="button"
                    className="tile-counter"
                    aria-expanded={isExpanded}
                    aria-label={
                      isExpanded ? 'Show fewer photos' : `Show all ${total} photos`
                    }
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {isExpanded ? '−' : `+${total - (TILE_CAP - 1)}`}
                  </button>
                </li>
              )}
            </ul>
          </div>
        </section>
      )}

      {/* Add-more on the left, the thing you actually came to do on the right.
          No disabled Upload button with nothing selected — a dead control is
          worse than no control. */}
      {!hero && (
        <div className="actions">
          {picker}
          {(total > 0 || busy) && (
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Uploading…' : `Upload ${photos(total)}`}
            </button>
          )}
          {!busy && total === 0 && done.length > 0 && (
            // The batch id travels in the URL, not in component state: leaving
            // this page drops the state, and the id is the only handle on the
            // photos that are already on disk.
            <Link className="btn" to={`/select?batch=${uploaded.batch}`}>
              Continue to photo selection
            </Link>
          )}
        </div>
      )}

      {busy && (
        <div className="progress">
          <div className="progress-label">
            <b>
              Uploading {progress.n} of {progress.total}
            </b>
            <span>{pct}%</span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.n}
            aria-valuetext={`${progress.n} of ${progress.total} photos uploaded`}
          >
            <div
              className="progress-fill"
              style={{
                width: `${progress.total ? (progress.n / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {hardError && (
        <div className="panel panel-error" role="alert">
          <span className="panel-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="panel-body">
            <p className="panel-head">{hardError.message}</p>
            {hardError.detail && <p className="panel-detail">{hardError.detail}</p>}
            {hardError.raw && <p className="panel-raw">{hardError.raw}</p>}
          </div>
        </div>
      )}

      {result && result.failed.length === 0 && (
        <div className="panel">
          <span className="panel-icon icon-ok">
            <CheckIcon />
          </span>
          <div className="panel-body">
            <p className="panel-head">Uploaded {photos(result.total)}</p>
            <p className="panel-detail">
              Saved to batch <code>{result.batch}</code>
            </p>
          </div>
        </div>
      )}

      {/* Accent, not danger: 198 of 200 landing is not a failure. But that
          reasoning collapses at zero — nothing landed, so say so in red. */}
      {result && result.failed.length > 0 && (
        <div className={`panel ${result.ok === 0 ? 'panel-error' : 'panel-partial'}`}>
          <span className={`panel-icon ${result.ok === 0 ? 'icon-danger' : 'icon-accent'}`}>
            <AlertIcon />
          </span>
          <div className="panel-body">
            <p className="panel-head">
              {result.stopped
                ? 'Upload stopped'
                : result.ok === 0
                  ? `Couldn't upload ${photos(result.total)}`
                  : `Uploaded ${result.ok} of ${result.total} photos`}
            </p>
            <p className="panel-detail">
              {result.stopped ? (
                `Lost the connection after ${result.ok} of ${result.total} photos. The ones that made it are saved — retry the rest.`
              ) : result.ok === 0 ? (
                // Nothing landed, so don't point at a batch as if it holds something.
                `The server rejected ${result.failed.length === 1 ? 'it' : 'all of them'}.`
              ) : result.isRetry ? (
                `Still couldn't upload ${photos(result.failed.length)}. Try again later or check the file names.`
              ) : (
                <>
                  {result.failed.length} didn&apos;t make it. Saved to batch{' '}
                  <code>{result.batch}</code>
                </>
              )}
            </p>

            <details
              className="failures"
              open={showFailed}
              onToggle={(e) => setShowFailed(e.currentTarget.open)}
            >
              <summary>{showFailed ? 'Hide what failed' : 'Show what failed'}</summary>
              <ul>
                {result.failed.map(({ file, reason }) => (
                  <li key={idOf(file)}>
                    <span className="failed-name">{file.name}</span>
                    <span className="failed-reason">{reason}</span>
                  </li>
                ))}
              </ul>
            </details>

            <p className="retry-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={retry}
              >
                Retry {photos(result.failed.length)}
              </button>
            </p>
          </div>
        </div>
      )}

      {/* Separate from the visible label on purpose: this one is throttled. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </p>
    </form>
  )
}
