import { useCallback, useEffect, useState } from 'react';

import { Overture } from './components/Overture';
import { SkyView } from './components/SkyView';
import { TimelineView } from './components/TimelineView';
import { GuideView } from './components/GuideView';
import { JournalView } from './components/JournalView';
import { OrientationSheet, orientationState } from './components/OrientationSheet';
import { SettingsSheet } from './components/SettingsSheet';
import { Diagnostics, diagnosticsRequested } from './components/Diagnostics';
import {
  IconCompassRose,
  IconEmblem,
  IconExplore,
  IconLogbook,
  IconMenu,
  IconSky,
  IconTonight,
} from './components/icons';

import { timezoneMismatch, useObserverSite } from './hooks/useObserverSite';
import { useEyePosition } from './hooks/useEyePosition';
import { useSmoothScroll } from './hooks/useSmoothScroll';
import { useOrientation } from './hooks/useOrientation';
import { useSkyData } from './hooks/useSkyData';
import { useJournal } from './lib/journal';
import type { SkyBody } from './lib/astro/types';
import type { Tone } from './lib/ai';

import './styles/tokens.css';
import './styles/app.css';
import './styles/overture.css';

type View = 'sky' | 'explore' | 'tonight' | 'logbook';

const VIEWS: { id: View; label: string; Icon: typeof IconSky }[] = [
  { id: 'sky', label: 'Sky', Icon: IconSky },
  { id: 'explore', label: 'Explore', Icon: IconExplore },
  { id: 'tonight', label: 'Tonight', Icon: IconTonight },
  { id: 'logbook', label: 'Logbook', Icon: IconLogbook },
];

const COMPASS_HINT: Record<string, string> = {
  live: 'Compass tracking',
  paused: 'Compass paused',
  ask: 'Turn on compass tracking',
  blocked: 'Compass unavailable: tap for why',
};

export default function App() {
  const { site, status, error, permission, requestGps, setManual, clear } = useObserverSite();
  const sky = useSkyData(site);
  const journal = useJournal();

  /*
   * The landing page is the way in every time, not only the first time.
   *
   * It used to be shown only while there was no stored site, which meant that
   * everyone who had ever answered the question never saw it again: they opened
   * the app straight onto the instrument. That is defensible for a tool and
   * wrong for this one. The page is the argument for the app, it computes a
   * real sky over Greenwich to make that argument, and it is the only place the
   * provenance of every number is written down. Skipping it for the people who
   * come back most is skipping it for almost everybody.
   *
   * A returning visitor is not asked again. Their site is already known, so the
   * closing plate offers the way in instead of the question, and offers the
   * question underneath it for the day they are somewhere else.
   *
   * Not persisted, deliberately. This is about opening the app, so it resets
   * with every load, which is the whole point.
   */
  const [entered, setEntered] = useState(false);

  // Orientation lives here rather than in the sky view, because the header's
  // rose reports it and the sky view is not always the visible screen.
  const orientation = useOrientation();
  const [followCompass, setFollowCompass] = useState(true);

  // Only on the way in. Once there is a site the app is a fixed instrument
  // panel, and reinterpreting scroll inside it would fight the sky view's own
  // drag handling for the same gestures.
  useSmoothScroll(!site);

  // The optics drift a little against the sky as the pointer crosses the
  // glass. Only on the sky screen: on a page of text it would be fidgeting.
  useEyePosition(!!site);

  const [view, setView] = useState<View>('sky');
  const [tone, setTone] = useState<Tone>('standard');
  const [sheet, setSheet] = useState<'none' | 'settings' | 'compass'>('none');
  const [nightVision, setNightVision] = useState(
    () => localStorage.getItem('borrowed-sky:vision') === 'night',
  );
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.vision = nightVision ? 'night' : 'normal';
    localStorage.setItem('borrowed-sky:vision', nightVision ? 'night' : 'normal');
  }, [nightVision]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const record = useCallback(
    (body: SkyBody) => {
      if (!site) return;
      journal.record(body, site);
      setToast(`${body.name} added to your journal`);
    },
    [journal, site],
  );

  if (!site || !entered) {
    return (
      <Overture
        status={status}
        error={error}
        permission={permission}
        knownSite={site}
        onEnter={() => setEntered(true)}
        /*
         * Answering the question is entering. Someone who has just tapped "use
         * my location" has said where they are and is waiting to be shown it;
         * handing them a second button would be asking them to agree twice.
         */
        onRequestGps={() => {
          setEntered(true);
          requestGps();
        }}
        onManual={(latitude, longitude, label) => {
          setEntered(true);
          setManual(latitude, longitude, label);
        }}
      />
    );
  }

  const compassLive = orientation.status === 'active' && followCompass;
  const compassState = orientationState(orientation, followCompass);

  return (
    <div className="app">
      {/* Only when the URL asks for it. See Diagnostics for why it exists. */}
      {diagnosticsRequested() && <Diagnostics />}

      <header className="topbar">
        <button
          className="rose rose--plain"
          onClick={() => setSheet('settings')}
          aria-label="Menu"
        >
          <span className="rose__face">
            <IconMenu size={20} />
          </span>
        </button>

        <div className="wordmark">
          <h1 className="wordmark__name">Borrowed Sky</h1>
          <p className="wordmark__tag">AI-powered stargazing companion</p>
        </div>

        <button
          className={`rose rose--${compassState}`}
          onClick={() => setSheet('compass')}
          aria-label={COMPASS_HINT[compassState]}
          title={COMPASS_HINT[compassState]}
        >
          <span className="rose__face">
            <IconCompassRose size={20} />
          </span>
        </button>
      </header>

      {timezoneMismatch(site) && (
        <p className="banner">
          Times are shown in this device's timezone, which does not match the coordinates you
          entered.
        </p>
      )}

      {/*
        Only the sky runs under the floating chrome. The reading views are
        documents, and a document whose first line sits behind the header is
        just a bug wearing a design.
      */}
      <main className={view === 'sky' ? 'app__main app__main--bleed' : 'app__main'}>
        {view === 'sky' && (
          <SkyView
            catalog={sky.catalog}
            constellations={sky.constellations}
            bodies={sky.bodies}
            site={site}
            now={sky.now}
            conditions={sky.conditions}
            timeline={sky.timeline}
            tone={tone}
            loadingCatalog={sky.loadingCatalog}
            catalogError={sky.catalogError}
            nightVision={nightVision}
            orientation={orientation}
            followCompass={followCompass}
            onFollowCompass={setFollowCompass}
            onChangeSite={clear}
            onToneChange={setTone}
            onRecord={record}
            onOpenGuide={() => setView('explore')}
            isLogged={journal.seenTonight}
          />
        )}

        {view === 'tonight' && (
          <TimelineView
            timeline={sky.timeline}
            site={site}
            now={sky.now}
            bodies={sky.bodies}
            conditions={sky.conditions}
            tone={tone}
            satelliteError={sky.satelliteError}
            onRetrySatellites={sky.refreshSatellites}
          />
        )}

        {view === 'explore' && (
          <GuideView
            site={site}
            now={sky.now}
            bodies={sky.bodies}
            conditions={sky.conditions}
            timeline={sky.timeline}
            tone={tone}
            onToneChange={setTone}
          />
        )}

        {view === 'logbook' && (
          <JournalView
            entries={journal.entries}
            stats={journal.stats}
            onRemove={journal.remove}
            onClear={journal.clear}
          />
        )}
      </main>

      {/*
        The optics. Over the sky, under the controls: a lens sits in front of
        what it is imaging and behind the hand working the instrument.
      */}
      <div className="optics" aria-hidden>
        <span className="optics__vignette" />
        <span className="optics__aperture" />
        <span className="optics__grain" />
      </div>

      {/*
        The filter night-vision mode puts the planet portraits through.

        A chain of CSS filters could not get there: sepia and hue-rotate barely
        move the pale tones, so Saturn stayed a yellow ball in the corner of an
        otherwise red screen — which costs exactly the dark adaptation the mode
        exists to protect. A colour matrix can do it exactly. Each channel is
        the pixel's Rec. 709 luminance scaled onto the red ramp, which is the
        same rule the star catalogue's night palette already uses: under red
        light the eye resolves no hue anyway, so only relative brightness is
        worth keeping.
      */}
      <svg className="visually-hidden" aria-hidden focusable="false">
        <filter id="night-ramp" colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0.2126 0.7152 0.0722 0 0
                    0.0808 0.2718 0.0274 0 0
                    0.0595 0.2003 0.0202 0 0
                    0      0      0      1 0"
          />
        </filter>
      </svg>

      {toast && (
        <p className="toast" role="status">
          {toast}
        </p>
      )}

      <nav className="rail" aria-label="Views">
        {VIEWS.slice(0, 2).map((item) => (
          <RailItem key={item.id} item={item} view={view} onSelect={setView} journal={journal} />
        ))}

        {/*
          The centre emblem returns to the sky and hands the view back to the
          compass, the "put me back where I am standing" control, which is the
          one thing you want after wandering off in a drag.
        */}
        <button
          className="rail__emblem"
          onClick={() => {
            setView('sky');
            setFollowCompass(true);
          }}
          aria-label="Back to the live sky"
          title="Back to the live sky"
        >
          <span className={compassLive ? 'rail__emblem-face is-live' : 'rail__emblem-face'}>
            <IconEmblem size={34} />
          </span>
        </button>

        {VIEWS.slice(2).map((item) => (
          <RailItem key={item.id} item={item} view={view} onSelect={setView} journal={journal} />
        ))}
      </nav>

      {sheet === 'settings' && (
        <SettingsSheet
          site={site}
          tone={tone}
          nightVision={nightVision}
          onTone={setTone}
          onNightVision={setNightVision}
          onChangeSite={clear}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'compass' && (
        <OrientationSheet
          orientation={orientation}
          following={followCompass}
          onFollow={setFollowCompass}
          onClose={() => setSheet('none')}
        />
      )}
    </div>
  );
}

function RailItem({
  item,
  view,
  onSelect,
  journal,
}: {
  item: (typeof VIEWS)[number];
  view: View;
  onSelect: (view: View) => void;
  journal: ReturnType<typeof useJournal>;
}) {
  const on = view === item.id;
  return (
    <button
      className={on ? 'rail__item is-on' : 'rail__item'}
      onClick={() => onSelect(item.id)}
      aria-current={on ? 'page' : undefined}
    >
      <item.Icon size={21} />
      <span className="rail__label">{item.label}</span>
      {item.id === 'logbook' && journal.stats.total > 0 && (
        <span className="rail__count readout">{journal.stats.distinctObjects}</span>
      )}
    </button>
  );
}
