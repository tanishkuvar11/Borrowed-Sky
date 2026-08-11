/**
 * The guide's nameplate, under the sky.
 *
 * A standing briefing rather than a conversation: it answers the question
 * someone standing outside actually has, which is "so what am I looking at",
 * without them having to think of a question first.
 *
 * The text is whatever the narrator genuinely produced from the computed sky.
 * It is never pre-written, never padded out to fill the plate, and when the
 * model is unreachable the plate says which voice is speaking rather than
 * quietly swapping one for the other.
 */

import { useEffect, useRef, useState } from 'react';

import { IconArmillary } from './icons';
import { askGuide, buildSkyContext, type GuideAnswer, type Tone } from '../lib/ai';
import type { TonightTimeline } from '../lib/astro/events';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';

/**
 * How often the briefing is rebuilt. The sky does not change fast enough to
 * justify more, and each rebuild may be a request.
 */
const REFRESH_MS = 4 * 60 * 1000;

export function GuidePlaque({
  site,
  now,
  bodies,
  conditions,
  timeline,
  tone,
  onOpenGuide,
}: {
  site: ObserverSite;
  now: Date;
  bodies: SkyBody[];
  conditions: SkyConditions | null;
  timeline: TonightTimeline | null;
  tone: Tone;
  onOpenGuide: () => void;
}) {
  const [answer, setAnswer] = useState<GuideAnswer | null>(null);

  // The briefing is rebuilt on a slow cadence of its own; keeping the inputs in
  // a ref stops the per-second clock tick from restarting the request.
  const inputs = useRef({ site, now, bodies, conditions, timeline, tone });
  inputs.current = { site, now, bodies, conditions, timeline, tone };

  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setEpoch((e) => e + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const current = inputs.current;
    if (!current.conditions || current.bodies.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const result = await askGuide({
          skyContext: buildSkyContext({
            now: current.now,
            site: current.site,
            bodies: current.bodies,
            conditions: current.conditions!,
            timeline: current.timeline,
          }),
          tone: current.tone,
          signal: controller.signal,
        });
        setAnswer(result);
      } catch {
        /* aborted on unmount or tone change */
      }
    })();

    return () => controller.abort();
    // Tone changes the wording, so it does justify a rebuild.
  }, [epoch, tone, conditions === null, bodies.length === 0]);

  return (
    <button className="plaque" onClick={onOpenGuide}>
      <span className="plaque__corner plaque__corner--tl" aria-hidden />
      <span className="plaque__corner plaque__corner--tr" aria-hidden />
      <span className="plaque__corner plaque__corner--bl" aria-hidden />
      <span className="plaque__corner plaque__corner--br" aria-hidden />

      <span className="plaque__mark" aria-hidden>
        <IconArmillary size={62} />
      </span>

      <span className="plaque__body">
        <span className="plaque__title engrave">
          AI Guide
          <span className="plaque__star" aria-hidden>
            ✦
          </span>
        </span>

        {answer ? (
          <>
            <span className="plaque__text">{answer.text}</span>
            {answer.source === 'local' && (
              <span className="plaque__source provenance">Built-in narrator</span>
            )}
          </>
        ) : (
          <span className="plaque__text plaque__text--waiting">Reading the sky…</span>
        )}
      </span>
    </button>
  );
}
