// Which value-add components are shown revealed (FR-75). A click reveals Models at once.
// The display client is revealed only once it is showing its views: while it waits for
// Play, for the models or for its handshake there is no value-add on screen to point at.
import { clientSession } from '../client/session';
import type { ComponentId } from './components';
import { revealed } from './selection';
import { useStore } from './store';

export function useRevealed(): ReadonlySet<ComponentId> {
  const clicked = useStore(revealed);
  const config = useStore(useStore(clientSession).config);
  if (!clicked.has('client') || (config && !config.rejected)) return clicked;
  return new Set([...clicked].filter((id) => id !== 'client'));
}
