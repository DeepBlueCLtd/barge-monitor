import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './shell/Shell';
// Annex A fonts (VS-01, VS-03), bundled so they are served from the site itself.
import '@fontsource/patrick-hand/400.css';
import '@fontsource/patrick-hand-sc/400.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
