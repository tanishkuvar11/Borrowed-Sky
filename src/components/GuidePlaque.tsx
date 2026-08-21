/**
 * The guide's panel, under the sky.
 *
 * A standing briefing rather than a conversation: it answers the question
 * someone standing outside actually has, which is "so what am I looking at",
 * without them having to think of a question first.
 *
 * The text is whatever the narrator genuinely produced from the computed sky.
 * It is never pre-written, never padded out to fill the panel, and when the
 * model is unreachable the panel says which voice is speaking rather than
 * quietly swapping one for the other.
 *
 * The furniture around the text is doing one job: saying that a machine is
 * reading the sky right now. So there is a sight at the left that sweeps while
 * a request is in flight and settles when one lands, and a portrait at the
 * right of the brightest thing currently above the horizon, which is what the
 * briefing will almost always be about. Both are driven by real state — the
 * sight is not decoration that runs forever, and the portrait is not a stock
 * picture of Saturn.
 *
 * What there is not is a typing animation. Text that types itself out is
 * pretending the answer is arriving as you read it, and it arrived all at once.
 */

import { useEffect, useRef, useState } from 'react';

import { PlanetMark } from './planet-marks';
import { askGuide, buildSkyContext, type GuideAnswer, type Tone } from '../lib/ai';
import type { TonightTimeline } from '../lib/astro/events';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';

/**
 * How often the briefing is rebuilt. The sky does not change fast enough to
 * justify more, and each rebuild may be a request.
 */
const REFRESH_MS = 4 * 60 * 1000;

/**
 * The sight at the left of the panel.
 *
 * Three rings and a set of quadrant marks, and the marks turn only while a
 * request is actually in flight. An indicator that animates whether or not
 * anything is happening is a decoration wearing the costume of a status light,
 * and it teaches people to stop reading it.
 */
function GuideSight({ working }: { working: boolean }) {
  return (
    <span className={working ? 'guide__sight is-working' : 'guide__sight'} aria-hidden>
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r="25" fill="none" stroke="currentColor" strokeWidth="0.7" opacity="0.28" />
        <circle cx="28" cy="28" r="17" fill="none" stroke="currentColor" strokeWidth="0.7" opacity="0.45" />
        <circle cx="28" cy="28" r="8.5" fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.7" />
        <circle cx="28" cy="28" r="2.4" fill="currentColor" />
        <g className="guide__sight-marks">
          {[0, 90, 180, 270].map((a) => (
            <line
              key={a}
              x1="28"
              y1="1.5"
              x2="28"
              y2="7.5"
              stroke="currentColor"
              strokeWidth="1.2"
              transform={`rotate(${a} 28 28)`}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}

/** The brightest thing above the horizon: what a briefing is usually about. */
function headline(bodies: SkyBody[]): SkyBody | null {
  const up = bodies.filter((b) => b.altitude > 0 && b.kind !== 'satellite');
  if (!up.length) return null;
  return up.reduce((best, b) => (b.magnitude < best.magnitude ? b : best));
}

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
  const [working, setWorking] = useState(false);

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
    setWorking(true);
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
      } finally {
        // An aborted request has been replaced by another one, which will set
        // this again on its own way in; clearing it here would blink the sight.
        if (!controller.signal.aborted) setWorking(false);
      }
    })();

    return () => controller.abort();
    // Tone changes the wording, so it does justify a rebuild.
  }, [epoch, tone, conditions === null, bodies.length === 0]);

  const subject = headline(bodies);

  return (
    <button className="guide-panel" onClick={onOpenGuide}>
      {/*
        One button, one destination: the guide.
        
        This briefly had a title row that expanded and collapsed the prose under
        it, which solved the phone problem and bought a second thing to
        understand. A panel that opens into a screen and also opens into itself
        is two controls wearing one coat. It is a button again, and the phone
        problem is solved where it belonged, in the stylesheet: at narrow widths
        the prose is not rendered at all and what is left is a labelled bar with
        an arrow, which is what a way in should look like.
      */}
      <span className="guide-panel__head">
        <GuideSight working={working} />

        <span className="guide-panel__title">
          AI Guide
          <span className="guide-panel__star" aria-hidden>
            ✦
          </span>
        </span>

        <span className="guide-panel__chevron" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor">
            <path d="M5 2l5 5-5 5" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </span>
      </span>

      <span className="guide-panel__body">
        {answer ? (
          <>
            <span className="guide-panel__text">{answer.text}</span>
            {answer.source === 'local' && (
              <span className="guide-panel__source provenance">Built-in narrator</span>
            )}
          </>
        ) : (
          <span className="guide-panel__text guide-panel__text--waiting">Reading the sky…</span>
        )}
      </span>

      {/*
        The subject of the briefing, in orbit at the right. Present only when
        something actually is up; on a clouded-over or daylight sky the corner
        is simply empty rather than showing a planet that is not there.
      */}
      {subject && (
        <span className="guide-panel__subject" aria-hidden>
          <span className="guide-panel__orbit" />
          <PlanetMark
            name={subject.name}
            kind={subject.kind}
            illuminatedFraction={subject.illuminatedFraction}
            size={124}
          />
        </span>
      )}
    </button>
  );
}
