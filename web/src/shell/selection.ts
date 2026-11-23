// What the viewer has picked: one component (FR-69), one message (FR-68), and
// which value-add components have been revealed (FR-74, FR-75).
import type { ComponentId } from './components';
import type { Message } from './messages';
import type { Pt } from './geometry';
import { Store } from './store';

export const selectedComponent = new Store<ComponentId | null>(null);
/**
 * A clicked message, haloed (VS-14), and where its icon was when clicked. One picked while
 * playing stays there, so it can be read. One picked while paused (`follow`) moves on with
 * the rest at Play and is deselected when it arrives.
 */
export const selectedMessage = new Store<{ m: Message; at: Pt; follow?: boolean } | null>(null);
/** Value-add components revealed so far. Only the display client and Models can be (AT-20). */
export const revealed = new Store<ReadonlySet<ComponentId>>(new Set());
/** The empty slot whose editor is open in the Models panel. */
export const openSlot = new Store<string | null>(null);

/** Revealed by a click. The display client is revealed by `useRevealed`, once it is showing its views in its panel. */
const REVEALED_BY_CLICK: ReadonlySet<ComponentId> = new Set(['models']);

export function selectComponent(id: ComponentId | null) {
  selectedComponent.set(id);
  selectedMessage.set(null);
  // FR-75: the first click on Models reveals it; nothing but Models and the display client can be revealed.
  if (id && REVEALED_BY_CLICK.has(id) && !revealed.value.has(id)) revealed.set(new Set([...revealed.value, id]));
}

/** Restart client un-reveals (FR-75: revealed "until the page is reloaded or the client restarts"). */
export function unrevealAll() {
  revealed.set(new Set());
}
