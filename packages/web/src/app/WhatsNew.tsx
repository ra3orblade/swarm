/**
 * What's New (M11.13): the release notes for the version you are running.
 *
 * Opened from the settings menu, from the desktop app's Help menu (`window.swarmWhatsNew`), and
 * once by itself after an upgrade.
 *
 * The notes are the markdown of our own `CHANGELOG.md`, split per version by `tools/build.ts` and
 * rendered here by the same renderer the session log uses. It used to be HTML generated at build
 * time and injected: one `<p>` per *source* line, so a sentence the changelog had wrapped arrived
 * as three paragraphs. Markdown in, elements out — and nothing left to inject.
 */
import { Markdown } from "../components/Markdown";
import { Modal } from "../components/Modal";
import { CHANGELOG_URL } from "../lib/external";
import type { ReleaseNote } from "../lib/releaseNotes";
import { markSeen } from "../lib/releaseNotes";

export function WhatsNew({ note, onClose }: { note: ReleaseNote; onClose: () => void }) {
  markSeen(note.version);
  return (
    <Modal
      title="What's New"
      glyph="gift"
      size="wn"
      onClose={onClose}
      footer={
        <a className="wn-full" href={CHANGELOG_URL} target="_blank" rel="noopener">
          Full changelog →
        </a>
      }
    >
      <h3>Swarm {note.version}</h3>
      {note.date && <div className="date">{note.date}</div>}
      <Markdown text={note.md} />
    </Modal>
  );
}
