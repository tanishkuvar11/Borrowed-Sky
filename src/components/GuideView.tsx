/**
 * The conversational guide.
 *
 * Every question is answered against a fresh snapshot of the computed sky, so
 * "what's that bright one?" resolves against what is genuinely overhead at the
 * moment of asking. The model is never the source of a position — only of the
 * sentence describing it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { askGuide, buildSkyContext, narrateLocally, type Tone } from '../lib/ai';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';
import type { TonightTimeline } from '../lib/astro/events';

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
  tone: Tone;
  onToneChange: (tone: Tone) => void;
}

export function GuideView({
  site,
  now,
  bodies,
  conditions,
  timeline,
  tone,
  onToneChange,
}: GuideViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // The live values change every second; the ask handler reads them from a ref
  // so it always sends the sky as it is at the instant the question is sent.
  const liveRef = useRef({ now, bodies, conditions, timeline });
  liveRef.current = { now, bodies, conditions, timeline };

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
        const answer = await askGuide({ skyContext: context, tone, question: trimmed });
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'guide',
            text: answer.text,
            provenance:
              answer.source === 'granite'
                ? `IBM Granite (${answer.model ?? 'watsonx'}), grounded in your computed sky.`
                : answer.note ?? 'Built-in narrator, from your computed sky.',
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

      <div className="chat">
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
