import { type CampaignNote, NoteSpoilerLevel, NoteStatus, NoteType } from '@dnd-lm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, describeApiError } from './api';
import { readNoteForm } from './note-form';

/**
 * Campaign → Notes (M8.5, FR-611): the notes the DM narrates from. Host and
 * admin only — the API refuses everyone else on reads too, since a note is
 * `dm`-level content; this page is simply not offered to a player.
 *
 * The body is a plain `<textarea>`: the DM reads the Markdown, not the host,
 * so there is no editor library and no preview.
 */
export function CampaignNotes({
  campaignId,
  campaignName,
  onClose,
}: {
  campaignId: string;
  campaignName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  /** The slug being edited, `'new'` for the create form, or nothing open. */
  const [editing, setEditing] = useState<string | null>(null);

  const notes = useQuery({
    queryKey: ['notes', campaignId],
    queryFn: () => api.notes(campaignId),
  });
  const done = () => {
    setEditing(null);
    return queryClient.invalidateQueries({ queryKey: ['notes', campaignId] });
  };
  const remove = useMutation({
    mutationFn: (slug: string) => api.deleteNote(campaignId, slug),
    onSuccess: done,
  });

  return (
    <main>
      <header>
        <h1>Notes — {campaignName}</h1>
        <p>
          What the DM knows about this campaign.{' '}
          <button type="button" onClick={onClose}>
            Back to campaigns
          </button>
        </p>
      </header>

      {notes.isPending && <p>Loading notes…</p>}
      {notes.error && (
        <p role="alert" className="error">
          {describeApiError(notes.error)}
        </p>
      )}
      {notes.isSuccess && notes.data.length === 0 && <p className="role">No notes yet.</p>}

      <ul>
        {(notes.data ?? []).map((note) => (
          <li key={note.slug}>
            <strong>{note.title}</strong> <code>{note.slug}</code>{' '}
            <span className="role">
              {note.type} · {note.spoilerLevel}
              {note.chapter === null ? '' : ` · chapter ${note.chapter}`}
              {note.status === 'draft' ? ' · draft' : ''}
            </span>{' '}
            <button type="button" onClick={() => setEditing(note.slug)}>
              Edit
            </button>{' '}
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete "${note.title}"? This cannot be undone.`)) {
                  remove.mutate(note.slug);
                }
              }}
            >
              Delete
            </button>
            {editing === note.slug && (
              <ExistingNote campaignId={campaignId} slug={note.slug} onDone={done} />
            )}
          </li>
        ))}
      </ul>
      {remove.error && (
        <p role="alert" className="error">
          {describeApiError(remove.error)}
        </p>
      )}

      {editing === 'new' ? (
        <NoteForm campaignId={campaignId} note={null} onDone={done} />
      ) : (
        <button type="button" onClick={() => setEditing('new')}>
          New note
        </button>
      )}
    </main>
  );
}

/** The list carries no bodies, so an edit reads the one note it opens. */
function ExistingNote({
  campaignId,
  slug,
  onDone,
}: {
  campaignId: string;
  slug: string;
  onDone: () => void;
}) {
  const note = useQuery({
    queryKey: ['note', campaignId, slug],
    queryFn: () => api.note(campaignId, slug),
  });
  if (note.isPending) return <p>Loading note…</p>;
  if (!note.data) {
    return (
      <p role="alert" className="error">
        {describeApiError(note.error)}
      </p>
    );
  }
  return <NoteForm campaignId={campaignId} note={note.data} onDone={onDone} />;
}

function NoteForm({
  campaignId,
  note,
  onDone,
}: {
  campaignId: string;
  note: CampaignNote | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const id = (field: string) => `note-${note?.slug ?? 'new'}-${field}`;
  const save = useMutation({
    mutationFn: (form: FormData) => {
      const fields = readNoteForm(form);
      return note
        ? api.updateNote(campaignId, note.slug, fields)
        : api.createNote(campaignId, { slug: String(form.get('slug') ?? ''), ...fields });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['note', campaignId, saved.slug], saved);
      onDone();
    },
  });

  return (
    <form
      className="settings"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      {!note && (
        <>
          <label htmlFor={id('slug')}>Slug</label>
          <input
            id={id('slug')}
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            title="lowercase letters, digits and single hyphens"
            placeholder="cragmaw-hideout"
          />
        </>
      )}
      <label htmlFor={id('title')}>Title</label>
      <input id={id('title')} name="title" required defaultValue={note?.title ?? ''} />

      <Choice
        id={id('type')}
        name="type"
        label="Type"
        options={NoteType.options}
        value={note?.type}
      />
      <Choice
        id={id('spoilerLevel')}
        name="spoilerLevel"
        label="Who may know it"
        options={NoteSpoilerLevel.options}
        value={note?.spoilerLevel ?? 'dm'}
      />
      <label htmlFor={id('chapter')}>Chapter (empty: always available)</label>
      <input
        id={id('chapter')}
        name="chapter"
        type="number"
        min={0}
        max={10000}
        step={1}
        defaultValue={note?.chapter ?? ''}
      />
      <Choice
        id={id('status')}
        name="status"
        label="Status"
        options={NoteStatus.options}
        value={note?.status ?? 'published'}
      />

      <label htmlFor={id('bodyMd')}>Body (Markdown)</label>
      <textarea id={id('bodyMd')} name="bodyMd" rows={12} defaultValue={note?.bodyMd ?? ''} />

      <button type="submit" disabled={save.isPending}>
        {note ? 'Save note' : 'Create note'}
      </button>
      <button type="button" onClick={onDone}>
        Cancel
      </button>
      {save.error && (
        <p role="alert" className="error">
          {describeApiError(save.error)}
        </p>
      )}
    </form>
  );
}

function Choice({
  id,
  name,
  label,
  options,
  value,
}: {
  id: string;
  name: string;
  label: string;
  options: readonly string[];
  value: string | undefined;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={value}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </>
  );
}
