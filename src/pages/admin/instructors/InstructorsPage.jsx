// /admin/instructors — top-level Instructors page.
//
// Lifted out of the Contacts > Instructors tab so Instructors is a first-class
// thing in the sidebar (matches how operators actually think about them:
// not just "contacts" but the contractors they're scheduling + paying).
//
// Renders the same InstructorsTab content — no logic moved, just the URL +
// sidebar position. The tab itself was already a full page worth of UI.

import { useOutletContext } from 'react-router-dom';
import InstructorsTab from '../contacts/InstructorsTab.jsx';

const INK = '#1a1a1a';
const MUTED = '#6b6b6b';

export default function InstructorsPage() {
  const { org } = useOutletContext() ?? {};

  return (
    <div>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          Instructors
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 14 }}>
          Contractors who teach for {org?.name ?? 'your org'}. Send onboarding invites, view rosters, upload prior background checks.
        </p>
      </header>

      <InstructorsTab org={org} />
    </div>
  );
}
