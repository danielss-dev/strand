import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

import { buildContentReportUrl, buildCrashIssueUrl } from '../../lib/crashReport';
import { osType } from '../../lib/integrations';
import { errMessage, isTauri, tauri } from '../../lib/tauri';
import { useSettings } from '../../stores/settings';
import { CheckRow } from './shared';

/**
 * Privacy — crash reporting (telemetry will join here when it lands).
 * The contract this section documents: panics are always logged *locally*;
 * a report only leaves the machine as a prefilled GitHub issue the user
 * reviews and submits in the browser. The launch-time offer is opt-in and
 * off by default (PRD §10).
 */
export function PrivacySection() {
  const crashPrompt = useSettings((s) => s.crashPrompt);
  const set = useSettings((s) => s.set);

  // Local crash-log location + size, for the disclosure line and to gray
  // out "Report last crash" when the log is empty. The huge `since` makes
  // this a pure metadata read (no entry extraction).
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logLen, setLogLen] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void tauri
      .crashReportCheck(Number.MAX_SAFE_INTEGER)
      .then((check) => {
        setLogPath(check.path);
        setLogLen(check.len);
      })
      .catch(() => {});
  }, []);

  const reportLast = async () => {
    try {
      const check = await tauri.crashReportCheck(0);
      if (!check.entry) {
        setStatus('No crashes recorded.');
        return;
      }
      const version = await getVersion().catch(() => 'unknown');
      await shellOpen(buildCrashIssueUrl(check.entry, version, osType()));
      setStatus('Report opened in your browser — review it before submitting.');
    } catch (e) {
      setStatus(`Couldn't open the report: ${errMessage(e)}`);
    }
  };

  const reportContent = async () => {
    try {
      const version = await getVersion().catch(() => 'unknown');
      await shellOpen(buildContentReportUrl(version, osType()));
      setStatus('Content report opened in your browser — review it before submitting.');
    } catch (e) {
      setStatus(`Couldn't open the report: ${errMessage(e)}`);
    }
  };

  return (
    <section className="settings-section" aria-label="Privacy">
      <div className="settings-field">
        <span className="settings-field-label">Content reports</span>
        <div className="settings-row">
          <button type="button" className="btn" onClick={() => void reportContent()}>
            Report inappropriate content…
          </button>
        </div>
        <p className="settings-hint">
          Report inappropriate pull-request, user-generated, or AI-generated content.
          Strand opens a pre-filled GitHub issue for you to review and submit; nothing
          is sent automatically.
        </p>
      </div>
      <div className="settings-field">
        <span className="settings-field-label">Crash reports</span>
        <div className="settings-rows">
          <CheckRow
            label="Offer to report crashes on launch"
            hint="After a crash, show a prompt that opens a pre-filled GitHub issue for you to review and submit. Nothing is sent automatically."
            checked={crashPrompt}
            onChange={(v) => set('crashPrompt', v)}
          />
        </div>
        <div className="settings-row">
          <button
            type="button"
            className="btn"
            disabled={!isTauri() || logLen === 0}
            onClick={() => void reportLast()}
          >
            Report last crash…
          </button>
        </div>
        {status && (
          <p className="settings-hint" role="status">
            {status}
          </p>
        )}
        <p className="settings-hint">
          Crashes are always logged locally
          {logPath ? (
            <>
              {' '}to <code>{logPath}</code>
            </>
          ) : null}
          . A report only leaves this machine when you submit the issue yourself — review it
          first; crash logs can include repository paths.
        </p>
      </div>
    </section>
  );
}
