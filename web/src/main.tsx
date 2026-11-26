import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
// Fonts are bundled, so they are served from the site itself (VS-04, AT-23):
// a hand-lettered face for the demonstrator (VS-01), a monospace face for
// message contents and code (VS-02), a plain sans-serif inside the monitor (VS-03).
import '@fontsource/patrick-hand/400.css';
import '@fontsource/patrick-hand-sc/400.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import './styles.css';
import { bus } from './shell/messages';
import { runtime } from './shell/runtime';

// For the end-to-end tests: the captured messages, as the flowchart holds them (AT-18, AT-53). Demonstrator shell only.
(window as unknown as { __messages: () => unknown[] }).__messages = () => bus.find(() => true);
(window as unknown as { __messageTotal: () => number }).__messageTotal = () => bus.total;
// Start-up milestones (NFR-10) and the model workers' phases, for the start-up budget test.
(window as unknown as { __startup: () => unknown }).__startup = () => ({ kind: runtime.kind, milestones: runtime.milestones, models: runtime.modelWorkers.value, progress: runtime.progress.value,
  server: runtime.server.value, fields: runtime.controlState.value?.fields?.filter((f) => !f.published_now || !f.on_next_start).map((f) => `${f.name}: on next start ${f.on_next_start}, published now ${f.published_now}`) });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
