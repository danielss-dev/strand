import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { DiffWorkerPool } from './components/DiffWorkerPool';
import { perfEnabled } from './lib/perf';
import { isTauri } from './lib/tauri';
import { useRepo } from './stores/repo';
import { useCustomView } from './stores/customView';
import { usePlugins } from './stores/plugins';
import { useSettings } from './stores/settings';
import { useWork } from './stores/work';
import { useWorkspaceReview } from './stores/workspaceReview';
import { useWorkspaces } from './stores/workspaces';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/features.css';

if (isTauri()) document.documentElement.classList.add('tauri');

// Perf-measurement test hook: exposes the zustand stores so an external
// CDP/devtools harness can drive the app (open repos, select files, stage)
// and observe renders without a native file dialog. Gated behind the same
// `strand:perf` flag as the perf instrumentation, so it never exists in
// normal release use. See docs/perf-baseline.md.
if (perfEnabled()) {
  (window as unknown as { __strand?: unknown }).__strand = {
    repo: useRepo,
    customView: useCustomView,
    plugins: usePlugins,
    settings: useSettings,
    work: useWork,
    workspaces: useWorkspaces,
    workspaceReview: useWorkspaceReview,
  };
}

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(
  <StrictMode>
    <DiffWorkerPool>
      <App />
    </DiffWorkerPool>
  </StrictMode>,
);
