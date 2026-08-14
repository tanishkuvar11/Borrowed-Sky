/**
 * The plain opening screen.
 *
 * The scrolling overture is the normal way in. This is the same ask without the
 * sky behind it, kept for the cases where a five-screen scroll would be the
 * wrong thing to put in someone's way, and it shares its permission handling
 * with the overture rather than reimplementing it.
 */

import { LocationAsk } from './LocationAsk';
import type { LocationStatus } from '../hooks/useObserverSite';

export interface LocationGateProps {
  status: LocationStatus;
  error: string | null;
  permission: PermissionState | 'unknown';
  onRequestGps: () => void;
  onManual: (latitude: number, longitude: number, label?: string) => void;
}

export function LocationGate({
  status,
  error,
  permission,
  onRequestGps,
  onManual,
}: LocationGateProps) {
  return (
    <div className="gate">
      <div className="gate__inner">
        <p className="engrave gate__eyebrow">Borrowed Sky</p>
        <h1 className="gate__title">
          The sky is <em>overhead</em>.<br />
          Here is what you are looking at.
        </h1>
        <p className="gate__lede">
          No telescope. No app to install. No prior knowledge. Point your phone up and this tells
          you what is there, computed for exactly where you are standing, right now.
        </p>

        <div className="hairline gate__rule" />

        <div className="gate__ask">
          <p className="engrave">One thing first</p>
          <p className="gate__ask-text">
            Every position depends on where on Earth you are. Your coordinates stay in your browser
            and are never stored on a server.
          </p>

          <LocationAsk
            status={status}
            error={error}
            permission={permission}
            onRequestGps={onRequestGps}
            onManual={onManual}
          />
        </div>

        <p className="provenance provenance--block gate__credits">
          Star positions from the HYG catalogue. Planets and the Moon from astronomy-engine.
          Satellites propagated with SGP4 from Celestrak orbital elements. Nothing in this app is
          simulated or placeholder data.
        </p>
      </div>
    </div>
  );
}
