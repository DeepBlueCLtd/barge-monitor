// Which value-add components are shown revealed (FR-75). A click reveals Models at once.
// The display client is revealed when two things are true together: it is showing its
// views (a dataset is open), and its detail panel is the one on screen. So the presenter chooses
// the moment: it never turns gold in the background, nor while its panel shows it waiting.
import { useEffect } from 'react';
import { clientSession } from '../client/session';
import type { ComponentId } from './components';
import { revealed, selectedComponent } from './selection';
import { useStore } from './store';

export function useRevealed(): ReadonlySet<ComponentId> {
  const shown = useStore(revealed);
  const selected = useStore(selectedComponent);
  const view = useStore(clientSession.view);
  const due = selected === 'client' && !!view;
  useEffect(() => {
    if (due && !revealed.value.has('client')) revealed.set(new Set([...revealed.value, 'client']));
  }, [due, shown]);
  return shown;
}
