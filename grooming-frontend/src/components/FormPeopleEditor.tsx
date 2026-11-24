import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertCircle, Loader2, UserPlus, UserRound, X } from 'lucide-react';
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
  box: Box | null;
}

export interface PhotoPeople {
  status: 'reading' | 'ready' | 'failed';
  stage?: ReadingStage;
  people: DraftPerson[];
  message?: string;
}

export interface EditablePhoto {
  key: string;
  title: string;
  imageUrl: string | null;
  // A person can be marked by hand only on a photo added now (its original is
  // at hand in the browser).
  canMarkByHand: boolean;
  people: PhotoPeople | undefined;
}

interface FormPeopleEditorProps {
  photos: EditablePhoto[];
  roster: FormInstructor[] | null;
  rosterError: string;
  disabled: boolean;
  onChoose: (photoKey: string, personKey: string, instructorId: string) => void;
  onRemove: (photoKey: string, personKey: string) => void;
  onMark: (photoKey: string, box: Box) => void;
}

const STAGE_TEXT: Record<ReadingStage, string> = {
  loading: 'Opening the photo…',
  people: 'Finding the people…',
  labels: 'Reading the name labels…',
};

// Drag a box around a person the photo reader missed.
function PersonMarker({ imageUrl, onCancel, onConfirm }: { imageUrl: string; onCancel: () => void; onConfirm: (box: Box) => void }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  const point = (event: ReactPointerEvent) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    const at = point(event);
    if (!at) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = at;
    setBox({ left: at.x, top: at.y, width: 0, height: 0 });
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    const at = start ? point(event) : null;
    if (!start || !at) return;
    setBox({
      left: Math.min(start.x, at.x),
      top: Math.min(start.y, at.y),
      width: Math.abs(at.x - start.x),
      height: Math.abs(at.y - start.y),
    });
  };

  const end = () => {
    startRef.current = null;
  };

  const usable = Boolean(box && box.width > 0.02 && box.height > 0.02);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="person-marker-title">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <h2 id="person-marker-title" className="text-base font-semibold text-slate-900">Mark a person</h2>
          <button type="button" onClick={onCancel} aria-label="Close" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="px-4 pt-3 text-sm text-slate-600">Drag a box around the person, from head to feet.</p>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <div
            ref={frameRef}
            className="relative inline-block touch-none select-none"
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <img src={imageUrl} alt="The group photo" draggable={false} className="block max-h-[65dvh] w-auto max-w-full" />
            {box && (
              <span
                aria-hidden="true"
                className="absolute border-2 border-indigo-500 bg-indigo-500/15"
                style={{ left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}
              />
            )}
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button type="button" onClick={onCancel} className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (box && usable) onConfirm(box); }}
            disabled={!usable}
            className="h-10 rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Add person
          </button>
        </div>
      </div>
    </div>
  );
}

// The people in each group photo: their picture, a name filled in from the
// label printed next to them (or chosen here), their ID, and a ✕ to remove
// someone who should not be listed.
export default function FormPeopleEditor({ photos, roster, rosterError, disabled, onChoose, onRemove, onMark }: FormPeopleEditorProps) {
  const [marking, setMarking] = useState<EditablePhoto | null>(null);
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
      <p className="text-sm text-slate-500">
        Names are filled in from the name labels printed in the photo. Check them, change any that are wrong, and choose a name for anyone left blank.
      </p>
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
                {photo.canMarkByHand && photo.imageUrl && state?.status !== 'reading' && (
                  <button
                    type="button"
                    onClick={() => setMarking(photo)}
                    disabled={disabled}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                  >
                    <UserPlus size={14} aria-hidden="true" />
                    Add a person
                  </button>
                )}
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
                  {photo.canMarkByHand ? ' Use Add a person to mark each person.' : ''}
                </p>
              )}

              {state?.status === 'ready' && state.people.length === 0 && (
                <p className="px-3 py-3 text-sm text-slate-500">
                  No people were found in this photo.{photo.canMarkByHand ? ' Use Add a person to mark them.' : ''}
                </p>
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
                        return (
                          <tr key={person.key} className="border-t border-slate-100 align-middle">
                            <td className="px-3 py-2">
                              <span className="block h-20 w-16 overflow-hidden rounded-md border border-slate-200 bg-slate-100">
                                {person.preview
                                  ? <img src={person.preview} alt={`Person ${index + 1}`} className="h-full w-full object-cover" />
                                  : <UserRound size={20} className="mx-auto mt-6 text-slate-300" aria-hidden="true" />}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={person.instructorId}
                                onChange={(event) => onChoose(photo.key, person.key, event.target.value)}
                                disabled={disabled || !roster}
                                aria-label={`Name of person ${index + 1}`}
                                className={`h-10 w-full min-w-[10rem] max-w-xs rounded-md border bg-white px-2 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${
                                  person.instructorId ? 'border-slate-300' : 'border-amber-300'
                                }`}
                              >
                                <option value="">{roster ? 'Choose a name' : 'Loading names…'}</option>
                                {(roster ?? []).map((option) => (
                                  <option key={option.id} value={option.id}>{option.name}</option>
                                ))}
                              </select>
                              {person.source === 'label' && person.instructorId && (
                                <span className="mt-1 block text-xs text-emerald-700">Filled in from the name label</span>
                              )}
                              {twice && <span className="mt-1 block text-xs text-amber-700">This name is chosen for more than one person</span>}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-700">{instructor?.employee_id || '—'}</td>
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

      {marking?.imageUrl && (
        <PersonMarker
          imageUrl={marking.imageUrl}
          onCancel={() => setMarking(null)}
          onConfirm={(box) => {
            onMark(marking.key, box);
            setMarking(null);
          }}
        />
      )}
    </div>
  );
}
