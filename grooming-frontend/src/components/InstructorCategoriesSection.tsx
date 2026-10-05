import { useEffect, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import { apiFetch, apiJson, invalidateCache } from '../api';
import {
  CATEGORIES_PATH,
  CATEGORY_MAX_LENGTH,
  categoryNameProblem,
  categoryPath,
  cleanCategoryName,
  instructorsLabel,
  type InstructorCategory,
} from '../lib/instructorCategories';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';

const FIELD = 'h-10 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
const ICON_BUTTON = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-40';

export default function InstructorCategoriesSection() {
  const toast = useToast();
  const [categories, setCategories] = useState<InstructorCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [addProblem, setAddProblem] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editProblem, setEditProblem] = useState('');
  const [deleting, setDeleting] = useState<InstructorCategory | null>(null);

  useEffect(() => {
    let disposed = false;
    apiFetch<InstructorCategory[]>(CATEGORIES_PATH)
      .then((data) => {
        if (!disposed) setCategories(Array.isArray(data) ? data : []);
      })
      .catch((error) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : 'Could not load the categories.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, []);

  const saved = (next: InstructorCategory[]) => {
    setCategories(Array.isArray(next) ? next : []);
    invalidateCache(CATEGORIES_PATH);
  };

  const failed = (title: string, error: unknown) => {
    toast.error(title, { detail: error instanceof Error ? error.message : String(error) });
  };

  const addCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = categoryNameProblem(newName, categories);
    setAddProblem(problem);
    if (problem) return;
    const name = cleanCategoryName(newName);
    setBusy(true);
    try {
      saved(await apiJson<InstructorCategory[]>(CATEGORIES_PATH, { method: 'POST', body: { name } }));
      setNewName('');
      toast.success('Category added', { detail: name });
    } catch (error) {
      failed('Could not add the category', error);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (category: InstructorCategory) => {
    setEditing(category.name);
    setEditName(category.name);
    setEditProblem('');
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditProblem('');
  };

  const renameCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const problem = categoryNameProblem(editName, categories, editing);
    setEditProblem(problem);
    if (problem) return;
    const name = cleanCategoryName(editName);
    if (name === editing) {
      cancelEdit();
      return;
    }
    setBusy(true);
    try {
      const result = await apiJson<{ moved: number; categories: InstructorCategory[] }>(categoryPath(editing), { method: 'PUT', body: { name } });
      saved(result.categories);
      invalidateCache('/api/v2/instructors?include_feedback=false');
      toast.success('Category renamed', {
        detail: result.moved ? `${editing} is now ${name} for ${instructorsLabel(result.moved)}.` : `${editing} is now ${name}.`,
      });
      cancelEdit();
    } catch (error) {
      failed('Could not rename the category', error);
    } finally {
      setBusy(false);
    }
  };

  const deleteCategory = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      saved(await apiFetch<InstructorCategory[]>(categoryPath(deleting.name), { method: 'DELETE' }));
      toast.success('Category deleted', { detail: deleting.name });
      setDeleting(null);
    } catch (error) {
      failed('Could not delete the category', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="instructor-categories" className="mt-6">
      <h3 id="instructor-categories" className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800">
        <Tags size={16} className="text-indigo-600" aria-hidden="true" />
        Instructor categories
      </h3>
      <p className="mb-3 text-sm text-slate-500">
        The Category choices shown when adding or editing an instructor. Categories that arrive from Sync Data are added here
        automatically. A category in use cannot be deleted; renaming one also renames it on its instructors.
      </p>

      <div className="rounded-md border border-slate-200 bg-white">
        <form onSubmit={addCategory} className="flex flex-wrap items-start gap-2 border-b border-slate-100 p-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <label htmlFor="new-category" className="sr-only">New category</label>
            <input
              id="new-category"
              value={newName}
              maxLength={CATEGORY_MAX_LENGTH}
              placeholder="New category, e.g. TECH"
              onChange={(event) => { setNewName(event.target.value); setAddProblem(''); }}
              aria-invalid={Boolean(addProblem)}
              aria-describedby={addProblem ? 'new-category-problem' : undefined}
              className={`${FIELD} w-full`}
            />
            {addProblem && <p id="new-category-problem" className="mt-1 text-xs font-medium text-rose-700">{addProblem}</p>}
          </div>
          <button
            type="submit"
            disabled={busy || loading}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
          >
            <Plus size={16} aria-hidden="true" />
            Add
          </button>
        </form>

        {loading ? (
          <p className="p-6 text-center text-sm text-slate-400">Loading categories…</p>
        ) : loadError ? (
          <p role="alert" className="m-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{loadError}</p>
        ) : categories.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-400">No categories yet. Add the first one above.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Instructor categories">
            {categories.map((category) => (
              <li key={category.name} className="flex items-center gap-3 px-4 py-3">
                {editing === category.name ? (
                  <form onSubmit={renameCategory} className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <label htmlFor="rename-category" className="sr-only">New name for {category.name}</label>
                      <input
                        id="rename-category"
                        autoFocus
                        value={editName}
                        maxLength={CATEGORY_MAX_LENGTH}
                        onChange={(event) => { setEditName(event.target.value); setEditProblem(''); }}
                        onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit(); }}
                        aria-invalid={Boolean(editProblem)}
                        aria-describedby={editProblem ? 'rename-category-problem' : undefined}
                        className={`${FIELD} w-full`}
                      />
                      {editProblem && <p id="rename-category-problem" className="mt-1 text-xs font-medium text-rose-700">{editProblem}</p>}
                    </div>
                    <button type="submit" disabled={busy} aria-label={`Save the new name for ${category.name}`} title="Save" className={`${ICON_BUTTON} mt-1 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus:ring-emerald-500`}>
                      <Check size={15} aria-hidden="true" />
                    </button>
                    <button type="button" disabled={busy} onClick={cancelEdit} aria-label="Cancel renaming" title="Cancel" className={`${ICON_BUTTON} mt-1 border-slate-200 bg-white text-slate-500 hover:bg-slate-50 focus:ring-indigo-500`}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-800">{category.name}</p>
                      <p className="text-xs text-slate-500">{category.count ? instructorsLabel(category.count) : 'Not used yet'}</p>
                    </div>
                    <button type="button" disabled={busy || editing !== null} onClick={() => startEdit(category)} aria-label={`Rename ${category.name}`} title="Rename" className={`${ICON_BUTTON} border-indigo-100 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500`}>
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={busy || editing !== null || category.count > 0}
                      onClick={() => setDeleting(category)}
                      aria-label={`Delete ${category.name}`}
                      title={category.count > 0 ? `In use by ${instructorsLabel(category.count)}` : 'Delete'}
                      className={`${ICON_BUTTON} border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500`}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        destructive
        busy={busy}
        title="Delete category"
        message={`Delete the category ${deleting?.name ?? ''}?`}
        detail="It will no longer be offered when adding or editing an instructor."
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => void deleteCategory()}
      />
    </section>
  );
}
