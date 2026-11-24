import { useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, UserRound, X } from 'lucide-react';
import type { Box } from '../lib/groupLabels';
import type { ReadingStage } from '../lib/groupPhotoReader';
import type { FormInstructor, PersonSource } from '../lib/instituteForm';

// One person in a photo while the form is being filled in.
export interface DraftPerson {
  key: string;
  // A person saved with an earlier submission.
  id?: string;
  // A new cut-out, sent with this submission.
  crop?: Blob;
  preview: string | null;
  instructorId: string;
  source: PersonSource;
  readText?: string;
  // The name and id printed on this person's label, used as they are when
  // the person is not in the institute's instructor list.
  labelName?: string;
  labelId?: string;
  box: Box | null;
}

export interface PhotoPeople {
  status: 'reading' | 'ready' | 'failed';
  stage?: ReadingStage;
  people: DraftPerson[];
  message?: string;
  // The instructors whose labels were read in this photo, offered first.
  photoInstructorIds?: string[];
  // How many name labels were read, and whether reading them failed.
  labelsRead?: number;
  labelsFailed?: boolean;
}

// The name list's value for "the name as printed in the photo".
export const PRINTED_NAME = '__printed__';

export interface EditablePhoto {
  key: string;
  title: string;
  people: PhotoPeople | undefined;
}

interface FormPeopleEditorProps {
  photos: EditablePhoto[];
  roster: FormInstructor[] | null;
  rosterError: string;
  disabled: boolean;
  onChoose: (photoKey: string, personKey: string, instructorId: string) => void;
  onRemove: (photoKey: string, personKey: string) => void;
}

const STAGE_TEXT: Record<ReadingStage, string> = {
  loading: 'Opening the photo…',
  people: 'Finding the people…',
  labels: 'Reading the name labels…',
};

interface PictureEntry {
  url: string | null;
  title: string;
  detail: string;
}

// One person's picture in a small window over the form (not full screen),
// with previous / next for the others in the same photo.
function PersonPicture({ entries, startIndex, onClose }: { entries: PictureEntry[]; startIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(startIndex);
  const count = entries.length;
  const entry = entries[index];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && count > 1) setIndex((value) => (value + 1) % count);
      if (event.key === 'ArrowLeft' && count > 1) setIndex((value) => (value - 1 + count) % count);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [count, onClose]);

  if (!entry) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="person-picture-title"
      onClick={onClose}
    >
      <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 id="person-picture-title" className="truncate text-base font-semibold text-slate-900">{entry.title}</h2>
            <p className="truncate text-xs text-slate-500">
              {entry.detail}
              {count > 1 ? ` · ${index + 1} of ${count}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" autoFocus className="-m-1 shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="relative flex items-center justify-center bg-slate-50 p-4">
          {entry.url
            ? <img src={entry.url} alt={entry.title} className="max-h-[60dvh] w-auto max-w-full rounded-md object-contain" />
            : <UserRound size={48} className="my-16 text-slate-300" aria-hidden="true" />}
          {count > 1 && (
            <>
              <button
                type="button"
                onClick={() => setIndex((value) => (value - 1 + count) % count)}
                aria-label="Previous person"
                className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow hover:bg-white"
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setIndex((value) => (value + 1) % count)}
                aria-label="Next person"
                className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow hover:bg-white"
              >
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// The people in each group photo: their picture, a name filled in from the
// label printed next to them (or chosen here), their ID, and a ✕ to remove
// someone who should not be listed.
export default function FormPeopleEditor({ photos, roster, rosterError, disabled, onChoose, onRemove }: FormPeopleEditorProps) {
  const [viewing, setViewing] = useState<{ photoKey: string; index: number } | null>(null);
  const byId = new Map((roster ?? []).map((instructor) => [instructor.id, instructor]));
  const chosen = new Map<string, number>();
  for (const photo of photos) {
    for (const person of photo.people?.people ?? []) {
      if (person.instructorId) chosen.set(person.instructorId, (chosen.get(person.instructorId) ?? 0) + 1);
    }
  }

  if (!photos.length) return null;

  return (
    <div className="mt-2">
      {rosterError && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
          <AlertCircle size={14} aria-hidden="true" />
          {rosterError}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-4">
        {photos.map((photo) => {
          const state = photo.people;
          return (
            <section key={photo.key} className="rounded-md border border-slate-200" aria-label={`People in ${photo.title}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                <p className="text-sm font-semibold text-slate-700">
                  {photo.title}
                  {state?.status === 'ready' && <span className="ml-1.5 font-normal text-slate-500">· {state.people.length} {state.people.length === 1 ? 'person' : 'people'}</span>}
                </p>
              </div>

              {(!state || state.status === 'reading') && (
                <p className="flex items-center gap-2 px-3 py-3 text-sm text-slate-600" role="status">
                  <Loader2 size={16} className="animate-spin text-indigo-600" aria-hidden="true" />
                  {state?.stage ? STAGE_TEXT[state.stage] : 'Getting ready…'}
                  <span className="text-xs text-slate-400">The first photo takes a little longer.</span>
                </p>
              )}

              {state?.status === 'failed' && (
                <p className="px-3 py-3 text-sm text-amber-700">
                  {state.message || 'This photo could not be read automatically.'}
                </p>
              )}

              {state?.status === 'ready' && state.people.length === 0 && (
                <p className="px-3 py-3 text-sm text-slate-500">No people were found in this photo.</p>
              )}

              {state?.status === 'ready' && state.people.length > 0 && state.labelsFailed && (
                <p className="px-3 pt-3 text-xs text-amber-700">The name labels could not be read on this device. Please choose each name.</p>
              )}
              {state?.status === 'ready' && state.people.length > 0 && !state.labelsFailed && state.labelsRead === 0 && (
                <p className="px-3 pt-3 text-xs text-amber-700">No name labels were found in this photo. Please choose each name.</p>
              )}

              {state?.status === 'ready' && state.people.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[22rem] text-left text-sm">
                    <thead className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      <tr>
                        <th scope="col" className="px-3 py-2">Image</th>
                        <th scope="col" className="px-3 py-2">Name</th>
                        <th scope="col" className="px-3 py-2">ID</th>
                        <th scope="col" className="px-2 py-2"><span className="sr-only">Remove</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.people.map((person, index) => {
                        const instructor = person.instructorId ? byId.get(person.instructorId) : undefined;
                        const twice = Boolean(person.instructorId && (chosen.get(person.instructorId) ?? 0) > 1);
                        const printed = !person.instructorId && Boolean(person.labelName || person.labelId);
                        const inPhoto = new Set(state.photoInstructorIds ?? []);
                        const fromPhoto = (roster ?? []).filter((option) => inPhoto.has(option.id));
                        const others = (roster ?? []).filter((option) => !inPhoto.has(option.id));
                        return (
                          <tr key={person.key} className="border-t border-slate-100 align-middle">
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => setViewing({ photoKey: photo.key, index })}
                                aria-label={`View the picture of person ${index + 1}`}
                                className="block h-20 w-16 overflow-hidden rounded-md border border-slate-200 bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                              >
                                {person.preview
                                  ? <img src={person.preview} alt={`Person ${index + 1}`} className="h-full w-full object-cover" />
                                  : <UserRound size={20} className="mx-auto text-slate-300" aria-hidden="true" />}
                              </button>
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={person.instructorId || (printed ? PRINTED_NAME : '')}
                                onChange={(event) => onChoose(photo.key, person.key, event.target.value)}
                                disabled={disabled || (!roster && !printed)}
                                aria-label={`Name of person ${index + 1}`}
                                className={`h-10 w-full min-w-[10rem] max-w-xs rounded-md border bg-white px-2 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${
                                  person.instructorId || printed ? 'border-slate-300' : 'border-amber-300'
                                }`}
                              >
                                <option value="">{roster ? 'Choose a name' : 'Loading names…'}</option>
                                {printed && (
                                  <option value={PRINTED_NAME}>{person.labelName || 'Name as printed'}</option>
                                )}
                                {fromPhoto.length > 0 ? (
                                  <>
                                    <optgroup label="Names in this photo">
                                      {fromPhoto.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                                    </optgroup>
                                    <optgroup label="All instructors">
                                      {others.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                                    </optgroup>
                                  </>
                                ) : (
                                  others.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)
                                )}
                              </select>
                              {person.source === 'label' && person.instructorId && (
                                <span className="mt-1 block text-xs text-emerald-700">Filled in from the name label</span>
                              )}
                              {printed && (
                                <span className="mt-1 block text-xs text-amber-700">As printed in the photo · not in the instructor list</span>
                              )}
                              {twice && <span className="mt-1 block text-xs text-amber-700">This name is chosen for more than one person</span>}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-700">
                              {instructor?.employee_id || (printed ? person.labelId : '') || '—'}
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => onRemove(photo.key, person.key)}
                                disabled={disabled}
                                aria-label={`Remove person ${index + 1}`}
                                title="Remove this person"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                              >
                                <X size={16} aria-hidden="true" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {viewing && (() => {
        const photo = photos.find((item) => item.key === viewing.photoKey);
        const people = photo?.people?.people ?? [];
        if (!photo || !people.length) return null;
        const entries = people.map((person, index) => {
          const instructor = person.instructorId ? byId.get(person.instructorId) : undefined;
          const name = instructor?.name || (!person.instructorId ? person.labelName : '') || `Person ${index + 1}`;
          const id = instructor?.employee_id || (!person.instructorId ? person.labelId : '') || 'No ID';
          return { url: person.preview, title: name, detail: `${id} · ${photo.title}` };
        });
        return (
          <PersonPicture
            entries={entries}
            startIndex={Math.min(viewing.index, entries.length - 1)}
            onClose={() => setViewing(null)}
          />
        );
      })()}
    </div>
  );
}
