export function AboutPanel() {
  return (
    <div className="about">
      <h2>What this is</h2>
      <p>A <strong>system and architecture demonstrator</strong> for people deciding whether to adopt this architecture for a small,
        long-lived system with an old store. An uncrewed electric cargo barge shuttles between two wharves on a fictional canal,
        day and night, with a weather sensor at the bow and another at the stern, logging to an old data logger.</p>
      <h3>It exists to make two claims</h3>
      <ol>
        <li><strong>C1. A standards facade over an awkward legacy store works.</strong> An OGC API-EDR server sits in front of a store it
          does not control, while that store grows. It is shown working over an awkward stand-in, <em>to be confirmed against a real one</em>.</li>
        <li><strong>C2. The architecture transfers to small, old systems.</strong> A standards seam, a clock and RNG as ports, scored
          ground truth, and Python analysis as an ordinary client.</li>
      </ol>
      <p>Both claims are supported by acceptance tests, not by this page.</p>
      <h3>Everything is fictional</h3>
      <p>The canal, its wharves, reaches, locks and tunnel are invented, and placed at a declared location in the open ocean so that no
        coordinate is anywhere someone lives. The weather is synthetic: plausible, not accurate. This is not a weather or navigation product.</p>
      <h3>Things to know</h3>
      <ul>
        <li>Everything runs in this browser tab: a TypeScript display, and Python (Pyodide) in two Web Workers: the backend and the analyst's workspace.</li>
        <li>Live data reaches the display by polling the EDR server once a second. This is a recorded placeholder, not a tested design for live delivery.</li>
        <li>Each visit starts a fresh seeded run; nothing persists between visits. Add <code>?seed=N</code> to the address to choose the run.</li>
        <li>Analysis results carry their scores against the run's manifest (its ground truth). A result is never presented as correct because it looks plausible.</li>
      </ul>
      <p><a href="../">Software requirements document</a> · <a href="https://github.com/DeepBlueCLtd/barge-monitor">Source</a></p>
    </div>
  );
}
