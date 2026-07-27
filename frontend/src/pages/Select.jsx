import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import './Select.css'

// Same three the swipe loop has always used. Redundancy is deliberately absent:
// it's a group judgement, not a per-photo one, and asking for it here is what
// the old duplicate key got wrong — the repeat is 40 photos back in the deck.
const CHOICES = [
  { verdict: 'cut', key: 'ArrowLeft', arrow: '←', label: 'Cut', hint: 'not worth posting' },
  { verdict: 'edit', key: 'ArrowUp', arrow: '↑', label: 'Edit', hint: 'has potential, needs work' },
  { verdict: 'keep', key: 'ArrowRight', arrow: '→', label: 'Keep', hint: 'good as-is' },
]

const photoUrl = (batch, name, w) =>
  `/api/photo?batch=${encodeURIComponent(batch)}&name=${encodeURIComponent(name)}&w=${w}`

export default function Select() {
  const [params] = useSearchParams()
  const batch = params.get('batch')

  const [files, setFiles] = useState(null)
  const [verdicts, setVerdicts] = useState({})
  const [i, setI] = useState(0)
  const [error, setError] = useState(null)
  const [broken, setBroken] = useState(false)
  const [unsaved, setUnsaved] = useState([])
  const history = useRef([])

  // `i` drives render; `cursor` is the synchronous truth. React batches two
  // keydowns landing in one task, so a vote that reads `i` from the closure
  // re-judges the same photo and silently skips the next. A ref advances
  // immediately, and unlike a state updater it is safe to have effects around.
  const cursor = useRef(0)
  const seek = useCallback((n) => {
    cursor.current = n
    setI(n)
  }, [])

  useEffect(() => {
    if (!batch) return
    let alive = true
    Promise.all([
      fetch(`/api/batch/${encodeURIComponent(batch)}`).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`server said ${r.status}`)),
      ),
      fetch(`/api/verdicts?batch=${encodeURIComponent(batch)}`).then((r) =>
        r.ok ? r.json() : { verdicts: {} },
      ),
    ])
      .then(([listing, saved]) => {
        if (!alive) return
        setFiles(listing.files.map((f) => f.name))
        setVerdicts(saved.verdicts || {})
        // Resume where the last session stopped rather than re-judging.
        const done = saved.verdicts || {}
        const next = listing.files.findIndex((f) => !(f.name in done))
        seek(next === -1 ? listing.files.length : next)
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [batch, seek])

  // A verdict that doesn't reach disk is worse than one you never made: you
  // walk away believing the batch is judged. Surface every failure, and say
  // which photo, because the deck has already moved on by then.
  const send = useCallback(
    async (name, verdict) => {
      try {
        const r = await fetch(`/api/verdict?batch=${encodeURIComponent(batch)}`, {
          method: 'POST',
          body: JSON.stringify({ name, verdict }),
        })
        if (!r.ok) {
          const { error: msg } = await r.json().catch(() => ({}))
          throw new Error(msg || `server said ${r.status}`)
        }
        setUnsaved((u) => u.filter((x) => x.name !== name))
      } catch (e) {
        setUnsaved((u) => [...u.filter((x) => x.name !== name), { name, reason: e.message }])
      }
    },
    [batch],
  )

  const vote = useCallback(
    (verdict) => {
      const n = cursor.current
      if (!files || n >= files.length) return
      const name = files[n]
      seek(n + 1)
      history.current.push(name)
      setVerdicts((v) => ({ ...v, [name]: verdict }))
      setBroken(false)
      send(name, verdict)
    },
    [files, seek, send],
  )

  const undo = useCallback(() => {
    if (!files) return
    // Falls back to the previous photo when there's no history: resuming a
    // session starts with an empty stack, and "can't undo the one I just
    // walked back into" is exactly when you reach for undo.
    const n = cursor.current
    const name = history.current.pop() ?? (n > 0 ? files[n - 1] : null)
    if (!name) return
    setVerdicts((v) => {
      const next = { ...v }
      delete next[name]
      return next
    })
    setBroken(false)
    seek(files.indexOf(name))
    send(name, null)
  }, [files, seek, send])

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const choice = CHOICES.find((c) => c.key === e.key)
      if (choice) {
        e.preventDefault()
        vote(choice.verdict)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vote, undo])

  if (!batch) {
    return (
      <section className="intro">
        <h2>Photo selection</h2>
        <p>No batch chosen. Upload some photos first.</p>
        <p className="back">
          <Link to="/upload">Back to upload</Link>
        </p>
      </section>
    )
  }

  if (error && !files) {
    return (
      <section className="intro">
        <h2>Photo selection</h2>
        <p className="error">Couldn&apos;t read batch {batch} — {error}</p>
        <p className="back">
          <Link to="/upload">Back to upload</Link>
        </p>
      </section>
    )
  }

  if (!files) return <p className="muted">Loading batch {batch}…</p>

  if (files.length === 0) {
    return (
      <section className="intro">
        <h2>Photo selection</h2>
        <p>Batch {batch} is empty.</p>
        <p className="back">
          <Link to="/upload">Back to upload</Link>
        </p>
      </section>
    )
  }

  const tally = CHOICES.map((c) => ({
    ...c,
    n: Object.values(verdicts).filter((v) => v === c.verdict).length,
  }))
  const judged = Object.keys(verdicts).length

  // Rendered on every screen, not just the pre-load error state — a verdict
  // that failed to save is the one thing you must never have to go looking for.
  const unsavedBanner = unsaved.length > 0 && (
    <div className="panel panel-error" role="alert">
      <div className="panel-body">
        <p className="panel-head">
          {unsaved.length === 1 ? "1 call didn't save" : `${unsaved.length} calls didn't save`}
        </p>
        <ul className="panel-detail">
          {unsaved.map((u) => (
            <li key={u.name}>
              {u.name} — {u.reason}
            </li>
          ))}
        </ul>
        <p className="panel-detail">Undo back to them and judge again, or reload to see what stuck.</p>
      </div>
    </div>
  )

  if (i >= files.length) {
    return (
      <section className="intro">
        {/* judged, not files.length — otherwise a verdict that failed to save
            is papered over by a heading claiming the whole deck is done. */}
        <h2>
          {judged === files.length
            ? `All ${files.length} judged`
            : `${judged} of ${files.length} judged`}
        </h2>
        {unsavedBanner}
        <p>Saved to the batch as you went. Nothing is deleted — cut just means not posted.</p>
        <ul className="tally">
          {tally.map((c) => (
            <li key={c.verdict}>
              <b>{c.n}</b> {c.label.toLowerCase()}
            </li>
          ))}
        </ul>
        <div className="done-actions">
          <button type="button" className="btn btn-secondary" onClick={undo}>
            Undo last
          </button>
          <Link className="btn btn-secondary" to="/upload">
            Back to upload
          </Link>
        </div>
      </section>
    )
  }

  const name = files[i]
  const next = files[i + 1]

  return (
    <section className="swipe">
      {unsavedBanner}
      <div className="swipe-head">
        <span className="counter">
          <b>{i + 1}</b> of {files.length}
        </span>
        <span className="running">
          {tally.map((c) => (
            <span key={c.verdict} className={`chip chip-${c.verdict}`}>
              {c.n} {c.label.toLowerCase()}
            </span>
          ))}
        </span>
      </div>

      <div className="stage">
        {broken ? (
          <div className="unreadable">
            <p>Can&apos;t display this one.</p>
            <p className="muted">{name}</p>
            <p className="muted">
              HEIC needs a decoder that isn&apos;t installed. Judge it from the name or skip.
            </p>
          </div>
        ) : (
          <img
            key={name}
            className="photo"
            src={photoUrl(batch, name, 1400)}
            alt={name}
            onError={() => setBroken(true)}
          />
        )}
      </div>
      {/* Decoded and in cache before you press a key, so the deck never stalls. */}
      {next && <img className="preload" src={photoUrl(batch, next, 1400)} alt="" aria-hidden />}

      <p className="filename">{name}</p>

      <div className="choices">
        {CHOICES.map((c) => (
          <button
            key={c.verdict}
            type="button"
            className={`choice choice-${c.verdict}`}
            onClick={(e) => {
              // Drop focus, or a later Space re-fires this verdict on the
              // next photo. Keyboard users still tab back to it.
              e.currentTarget.blur()
              vote(c.verdict)
            }}
          >
            <span className="choice-arrow" aria-hidden>
              {c.arrow}
            </span>
            <span className="choice-label">{c.label}</span>
            <span className="choice-hint">{c.hint}</span>
          </button>
        ))}
      </div>

      <div className="swipe-foot">
        <button
          type="button"
          className="btn-text"
          onClick={undo}
          disabled={history.current.length === 0 && i === 0}
        >
          ⌫ Undo
        </button>
        <Link to="/upload">Back to upload</Link>
      </div>

      <p aria-live="polite" className="sr-only">
        Photo {i + 1} of {files.length}
      </p>
    </section>
  )
}
