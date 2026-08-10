import { useCallback, useEffect, useState } from 'react';

import { LocationGate } from './components/LocationGate';
import { SkyView } from './components/SkyView';
import { TimelineView } from './components/TimelineView';
import { GuideView } from './components/GuideView';
import { JournalView } from './components/JournalView';

import { timezoneMismatch, useObserverSite } from './hooks/useObserverSite';
import { useSkyData } from './hooks/useSkyData';
import { useJournal } from './lib/journal';
import { DARKNESS_LABEL } from './lib/astro/solar';
import type { SkyBody } from './lib/astro/types';
import type { Tone } from './lib/ai';

import './styles/tokens.css';
import './styles/app.css';

type View = 'sky' | 'tonight' | 'guide' | 'journal';

const VIEWS: { id: View; label: string }[] = [
  { id: 'sky', label: 'Sky' },
  { id: 'tonight', label: 'Tonight' },
  { id: 'guide', label: 'Guide' },
  { id: 'journal', label: 'Journal' },
];

export default function App() {
  const { site, status, error, requestGps, setManual, clear } = useObserverSite();
  const sky = useSkyData(site);
  const journal = useJournal();

  const [view, setView] = useState<View>('sky');
  const [tone, setTone] = useState<Tone>('standard');
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

  if (!site) {
    return (
      <LocationGate
        status={status}
        error={error}
        onRequestGps={requestGps}
        onManual={setManual}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__place">
          <span className="engrave">
            {site.source === 'gps' ? 'Your location' : 'Set by hand'}
          </span>
          <button className="topbar__coords readout" onClick={clear} title="Change location">
            {site.latitude.toFixed(2)}°, {site.longitude.toFixed(2)}°
          </button>
        </div>

        <div className="topbar__conditions">
          <span className="engrave">
            {sky.conditions ? DARKNESS_LABEL[sky.conditions.darkness] : 'Reading sky'}
          </span>
          <span className="readout topbar__clock">
            {sky.now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <button
          className={nightVision ? 'pill is-on' : 'pill'}
          onClick={() => setNightVision((v) => !v)}
          aria-pressed={nightVision}
          title="Red-only display, so a bright screen does not cost you your night vision"
        >
          Night vision
        </button>
      </header>

      {timezoneMismatch(site) && (
        <p className="banner">
          Times are shown in this device's timezone, which does not match the coordinates you
          entered.
        </p>
      )}

      <main className="app__main">
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
            onToneChange={setTone}
            onRecord={record}
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

        {view === 'guide' && (
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

        {view === 'journal' && (
          <JournalView
            entries={journal.entries}
            stats={journal.stats}
            onRemove={journal.remove}
            onClear={journal.clear}
          />
        )}
      </main>

      {toast && (
        <p className="toast" role="status">
          {toast}
        </p>
      )}

      <nav className="rail" aria-label="Views">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? 'rail__item is-on' : 'rail__item'}
            onClick={() => setView(item.id)}
            aria-current={view === item.id ? 'page' : undefined}
          >
            {item.label}
            {item.id === 'journal' && journal.stats.total > 0 && (
              <span className="rail__count readout">{journal.stats.distinctObjects}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
