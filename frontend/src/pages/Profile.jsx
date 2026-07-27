import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import './Profile.css'

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)

export default function Profile() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(
    () =>
      fetch('/api/learn')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`server said ${r.status}`))))
        .then(setData)
        .catch((e) => setError(e.message)),
    [],
  )

  useEffect(() => {
    load()
  }, [load])

  // Poll only while a run is in flight; a derive plus two scoring passes takes
  // minutes, and the page is the only place progress is visible.
  useEffect(() => {
    if (data?.state !== 'running') return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [data?.state, load])

  async function learn() {
    setError(null)
    await fetch('/api/learn', { method: 'POST' }).catch((e) => setError(e.message))
    load()
  }

  if (error && !data) {
    return (
      <section className="intro">
        <h2>Taste profile</h2>
        <p className="error">Couldn&apos;t reach the backend — {error}</p>
      </section>
    )
  }
  if (!data) return <p>Loading…</p>

  const running = data.state === 'running'
  const kept = (data.history || []).filter((h) => h.kept)
  const best = kept.length ? kept[kept.length - 1] : null

  return (
    <section className="profile">
      <div className="intro">
        <h2>Taste profile</h2>
        <p>
          Derived from your own keep/cut/edit calls, then scored on photos it never saw.
          It only replaces the previous one when it scores better.
        </p>
      </div>

      {best && (
        <div className="score">
          <div className="score-main">
            <b>{pct(best.with_rules, best.test)}%</b>
            <span>agreement with you, on {best.test} held-out photos</span>
          </div>
          <div className="score-sub">
            {pct(best.baseline, best.test)}% without the rules ·{' '}
            <b className={best.delta_points > 0 ? 'up' : ''}>
              {best.delta_points > 0 ? '+' : ''}
              {best.delta_points} points
            </b>
          </div>
        </div>
      )}

      {data.single_intent !== false && best?.single_intent && (
        <p className="warn">
          Every labelled folder has the same intent ({best.intents.join(', ')}). Rules
          learned here mix your taste with that day&apos;s circumstances — label a folder
          with a different intent and the two can be told apart.
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn" onClick={learn} disabled={running}>
          {running ? 'Learning…' : 'Learn from my labels'}
        </button>
        {running && <span className="step">{data.step}</span>}
        {data.state === 'error' && <span className="error">{data.error}</span>}
      </div>

      {data.profile ? (
        <pre className="rules">{data.profile}</pre>
      ) : (
        <p className="muted">
          No profile yet. Judge a batch on the <Link to="/select">selection</Link> page — the
          system tags it and learns from it on its own.
        </p>
      )}

      {(data.history || []).length > 0 && (
        <table className="runs">
          <thead>
            <tr>
              <th>when</th>
              <th>held out</th>
              <th>no rules</th>
              <th>with rules</th>
              <th>kept</th>
            </tr>
          </thead>
          <tbody>
            {[...data.history].reverse().map((h) => (
              <tr key={h.at}>
                <td>{h.at.replace('T', ' ')}</td>
                <td>{h.test}</td>
                <td>{pct(h.baseline, h.test)}%</td>
                <td>{pct(h.with_rules, h.test)}%</td>
                <td>{h.kept ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
