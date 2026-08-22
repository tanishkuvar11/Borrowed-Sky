/**
 * The conversational guide.
 *
 * Every question is answered against a fresh snapshot of the computed sky, so
 * "what's that bright one?" resolves against what is genuinely overhead at the
 * moment of asking. The model is never the source of a position, only of the
 * sentence describing it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  askGuide,
  buildSkyContext,
  narrateLocally,
  type GuideAnswer,
  type Tone,
} from '../lib/ai';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';
import { skyQualityInput } from '../lib/astro/solar';
import { skyQuality } from '../lib/astro/skyquality';
import type { TonightTimeline } from '../lib/astro/events';
import { createSkyToolset } from '../lib/astro/tools';
import { retrieve } from '../lib/corpus';
import type { StarCatalog } from '../lib/astro/starfield';
import type { TleSet } from '../lib/astro/satellites';

/**
 * The line under an answer saying where it came from.
 *
 * Names the functions when the model called any, because that is the part
 * worth seeing: an answer that says "Saturn sets at 03:12" is an assertion, and
 * the same answer with "looked up: rise_set" under it is a claim with a route
 * back to the arithmetic that produced it. This app's argument is that the
 * route is always there; this is where it shows.
 */
function provenanceFor(answer: GuideAnswer): string {
  const looked = answer.toolsUsed?.length ? ` Looked up: ${answer.toolsUsed.join(', ')}.` : '';
  const read = answer.sources?.length
    ? ` Explained from NASA: ${[...new Set(answer.sources.map((s) => s.title))].join('; ')}.`
    : '';
  if (answer.source === 'granite') {
    return `IBM Granite (${answer.model ?? 'watsonx'}), grounded in your computed sky.${looked}${read}`;
  }
  return `${answer.note ?? 'Built-in narrator, from your computed sky.'}${looked}${read}`;
}

interface Message {
  id: string;
  role: 'you' | 'guide';
  text: string;
  provenance?: string;
}

const SUGGESTIONS = [
  "What's the brightest thing up right now?",
  'Where should I look first?',
  'Is the space station coming over?',
  'Why does the Moon look like that tonight?',
];

export interface GuideViewProps {
  site: ObserverSite;
  now: Date;
  bodies: SkyBody[];
  conditions: SkyConditions | null;
  timeline: TonightTimeline | null;
  /** The catalogue and the elements, so the model's lookups can reach them. */
  catalog: StarCatalog | null;
  tleSet: TleSet | null;
  tone: Tone;
  onToneChange: (tone: Tone) => void;
}

/**
 * What the fitted sky model is doing tonight, in a sentence.
 *
 * The model earns its place by changing the chart, but a thinner field is not
 * self-explanatory: somebody looking at it has no way to know a model touched
 * it, or why. This says so, next to the conditions it is a correction to, and
 * it reports the size of the correction rather than describing it in adjectives
 * so that the claim stays checkable.
 *
 * It also says when it is doing nothing, which is most of the time. Silence
 * would read as a broken feature; "only after astronomical dark" reads as the
 * boundary it actually is.
 */
function skyQualityNote(site: ObserverSite, conditions: SkyConditions): string {
  const { adjustment, localised } = skyQuality(skyQualityInput(site, conditions));

  if (conditions.sunAltitude >= -18) {
    return 'No correction yet. The model only speaks once the Sun is 18° down.';
  }

  const size = Math.abs(adjustment).toFixed(1);
  const source = localised
    ? 'the Moon and the lights near you'
    : 'the Moon alone, with no observations reported near here';

  if (Math.abs(adjustment) < 0.05) {
    return `About a typical dark sky, judged on ${source}.`;
  }
  return adjustment < 0
    ? `${size} magnitudes of sky lost to ${source}.`
    : `${size} magnitudes better than average, on ${source}.`;
}

export function GuideView({
  site,
  now,
  bodies,
  conditions,
  timeline,
  catalog,
  tleSet,
  tone,
  onToneChange,
}: GuideViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // The live values change every second; the ask handler reads them from a ref
  // so it always sends the sky as it is at the instant the question is sent.
  const liveRef = useRef({ now, bodies, conditions, timeline, catalog, tleSet });
  liveRef.current = { now, bodies, conditions, timeline, catalog, tleSet };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, asking]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || asking) return;

      const live = liveRef.current;
      if (!live.conditions) return;

      setMessages((prev) => [...prev, { id: `q-${Date.now()}`, role: 'you', text: trimmed }]);
      setDraft('');
      setAsking(true);

      const context = buildSkyContext({
        now: live.now,
        site,
        bodies: live.bodies,
        conditions: live.conditions,
        timeline: live.timeline,
      });

      try {
        /*
         * The guide gets the tools; the plaque on the chart does not.
         *
         * A caption describing what is up needs no lookups and should not spend
         * two round trips deciding that. A question typed by a person is the
         * opposite case: it is exactly the thing a snapshot cannot answer in
         * advance, and it is worth the wait.
         */
        /*
         * Background first, then the question.
         *
         * Retrieved rather than offered as a tool the model may choose,
         * because the questions that need a source are precisely the ones a
         * model answers from memory without noticing it needed one. "Why is
         * Mars red" does not feel to a model like a question it cannot
         * already answer.
         */
        const found = await retrieve(trimmed);

        const answer = await askGuide({
          skyContext: context,
          tone,
          question: trimmed,
          sources: found.passages,
          tools: createSkyToolset({
            site,
            catalog: live.catalog,
            tleSet: live.tleSet,
          }),
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'guide',
            text: answer.text,
            provenance: provenanceFor(answer),
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'guide',
            text: narrateLocally(context, tone, trimmed),
            provenance: 'Built-in narrator, from your computed sky.',
          },
        ]);
      } finally {
        setAsking(false);
      }
    },
    [asking, site, tone],
  );

  return (
    <div className="view view--column">
      <div className="view__pad guide__head">
        <p className="engrave">Sky guide</p>
        <h2 className="view__title">Ask about anything above you</h2>
        <p className="view__lede">
          Answers are built from the positions this app computes for your location and this minute.
          If something is not in that data, the guide will say so rather than guess.
        </p>
        <div className="toggle" role="group" aria-label="Explanation detail">
          <button
            className={tone === 'simple' ? 'toggle__option is-on' : 'toggle__option'}
            onClick={() => onToneChange('simple')}
          >
            Explain like I'm 10
          </button>
          <button
            className={tone === 'standard' ? 'toggle__option is-on' : 'toggle__option'}
            onClick={() => onToneChange('standard')}
          >
            Standard
          </button>
        </div>
      </div>

      <div className={messages.length === 0 ? 'chat chat--empty' : 'chat'}>
        {messages.length === 0 && (
          <div className="chat__empty">
            <p className="engrave">Try asking</p>
            <div className="chat__suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="pill" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>

            {/*
              What the guide is actually holding when you ask.

              This space used to be blank, and blank was the wrong answer for
              it: the page's claim, two paragraphs up, is that answers come
              from computed positions and nothing else. Printing the count and
              the conditions is that claim being checkable rather than stated,
              and it is the same snapshot the question will be sent with.
            */}
            {conditions && (
              <dl className="context-note">
                <div>
                  <dt className="engrave">In view</dt>
                  <dd>
                    {bodies.filter((b) => b.altitude > 0).length} of {bodies.length} objects above
                    your horizon
                  </dd>
                </div>
                <div>
                  <dt className="engrave">Conditions</dt>
                  <dd>{conditions.summary}</dd>
                </div>
                <div>
                  <dt className="engrave">Moon</dt>
                  <dd>
                    {conditions.moonPhaseName} ·{' '}
                    {Math.round(conditions.moonIlluminatedFraction * 100)}% lit ·{' '}
                    {conditions.moonAltitude > 0
                      ? `${Math.round(conditions.moonAltitude)}° up`
                      : 'below the horizon'}
                  </dd>
                </div>
                <div>
                  <dt className="engrave">Your sky</dt>
                  <dd>
                    {skyQualityNote(site, conditions)}{' '}
                    <span className="context-note__source">
                      Fitted to 122,000 Globe at Night observations.
                    </span>
                  </dd>
                </div>
              </dl>
            )}
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`bubble bubble--${message.role}`}>
            <p className="bubble__text">{message.text}</p>
            {message.provenance && <p className="provenance">{message.provenance}</p>}
          </div>
        ))}

        {asking && (
          <div className="bubble bubble--guide bubble--thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <input
          className="composer__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What's that bright one?"
          aria-label="Ask the sky guide a question"
          disabled={!conditions}
        />
        <button className="button button--primary" type="submit" disabled={asking || !draft.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
