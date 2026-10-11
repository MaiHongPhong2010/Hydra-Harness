/** Bounded transient animation; reduced motion hides the entire effect. */
import type { CSSProperties } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { ConfettiRequest } from '@hydraharness/harness-toys/types'
import css from './ConfettiOverlay.module.css'

type Props = PropsRuntime<'shell.overlay'> & InjectFace<{ hooks: { effect: HostObservable<ConfettiRequest | undefined> } }>

/**
 * @param props - live effect snapshot.
 * @returns transient particles, or no overlay.
 */
export function ConfettiOverlay({ useEffect: useEffectSnapshot }: Props) {
  const request = useEffectSnapshot(value => value)
  if (request === undefined) return null
  return <div key={request.id} className={css.overlay} aria-hidden="true">
    {Array.from({ length: request.particles }, (_, index) => <i key={index} className={css.particle} style={{
      '--x': `${(index * 47) % 101}%`, '--drift': `${((index * 67) % 301) - 150}px`, '--spin': `${index * 59}deg`,
      '--color': `hsl(${String((index * 137) % 360)} 80% 60%)`, '--duration': `${request.durationMs}ms`,
    } as CSSProperties} />)}
  </div>
}
