import React, { useEffect, useRef, useState } from 'react';
import { Camera, UploadCloud, RefreshCw, LogOut, MapPin } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { validatePhoto } from '../imageValidation';

function getCoordinates() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ coordinates: null, error: 'Location is not supported by this device.' });
      return;
    }
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          coordinates: `${position.coords.latitude},${position.coords.longitude}`,
          error: '',
        }),
        () => resolve({
          coordinates: null,
          error: 'Location was unavailable. Check-in will continue without coordinates.',
        }),
        { enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 },
      );
    } catch {
      resolve({ coordinates: null, error: 'Location could not be accessed. Check-in will continue without coordinates.' });
    }
  });
}

export default function EvaluateCard({ instructors, fetchInstructors }) {
  const [selectedUuid, setSelectedUuid] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });
  const fileInputRef = useRef(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const resetPhoto = () => {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = (event) => {
    const selected = event.target.files?.[0];
    const validationError = validatePhoto(selected);
    if (validationError) {
      resetPhoto();
      setMessage({ type: 'error', text: validationError });
      return;
    }
    setFile(selected);
    setPreview(URL.createObjectURL(selected));
    setMessage({ type: '', text: '' });
  };

  const handleCheckIn = async () => {
    const photoError = validatePhoto(file);
    if (!selectedUuid || photoError) {
      setMessage({
        type: 'error',
        text: !selectedUuid ? 'Select an instructor to continue.' : photoError,
      });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    setLocationStatus('Getting location…');
    const location = await getCoordinates();
    setLocationStatus(location.error);

    const formData = new FormData();
    formData.append('instructor_id', selectedUuid);
    formData.append('file', file);
    if (location.coordinates) formData.append('location_coordinates', location.coordinates);

    try {
      const result = await apiFetch('/api/v2/attendance/check-in', {
        method: 'POST',
        body: formData,
        timeoutMs: 75_000,
      });
      setMessage({ type: 'success', text: result?.message || 'Check-in queued for AI analysis.' });
      resetPhoto();
      setSelectedUuid('');
      await fetchInstructors();
    } catch (error) {
      setMessage({ type: 'error', text: `Check-in failed: ${error.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOut = async () => {
    if (!selectedUuid) {
      setMessage({ type: 'error', text: 'Select an instructor to check out.' });
      return;
    }

    setCheckoutLoading(true);
    setMessage({ type: '', text: '' });
    try {
      const result = await apiJson('/api/v2/attendance/check-out', {
        method: 'POST',
        body: { instructor_id: selectedUuid },
      });
      setMessage({ type: 'success', text: result?.message || 'Check-out completed.' });
      setSelectedUuid('');
      await fetchInstructors();
    } catch (error) {
      setMessage({ type: 'error', text: `Check-out failed: ${error.message}` });
    } finally {
      setCheckoutLoading(false);
    }
  };

  return (
    <section className="bg-white rounded-md shadow-xl shadow-slate-200/50 p-6 md:p-8 flex flex-col h-full border border-slate-100 relative overflow-hidden group" aria-labelledby="attendance-action-title">
      <div className="absolute top-0 right-0 -mt-16 -mr-16 w-48 h-48 bg-indigo-50 rounded-full blur-3xl opacity-60 pointer-events-none group-hover:bg-indigo-100 transition-colors duration-700" />

      <div className="relative z-10">
        <h2 id="attendance-action-title" className="text-xl md:text-2xl font-extrabold text-slate-800 mb-2 tracking-tight">Attendance Action</h2>
        <p className="text-slate-500 text-sm mb-6 font-medium">Select an instructor to check in or check out.</p>

        {message.text && (
          <div
            role={message.type === 'error' ? 'alert' : 'status'}
            className={`mb-5 rounded-md border p-3 text-sm font-medium ${message.type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
          >
            {message.text}
          </div>
        )}

        <div className="mb-6">
          <label htmlFor="instructor-select" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Select Instructor</label>
          <div className="relative">
            <select
              id="instructor-select"
              className="w-full rounded-md border-2 border-slate-100 bg-slate-50 p-4 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none appearance-none cursor-pointer transition-all hover:bg-slate-100"
              value={selectedUuid}
              onChange={(event) => setSelectedUuid(event.target.value)}
            >
              <option value="">-- Choose Instructor --</option>
              {instructors.map((instructor) => (
                <option key={instructor._id} value={instructor._id}>{instructor.name} ({instructor.employee_id})</option>
              ))}
            </select>
            <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none text-slate-400" aria-hidden="true">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col mb-6">
          <label htmlFor="check-in-photo" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Check-In Photo</label>
          <div className="flex-1 min-h-[240px] border-3 border-dashed border-slate-200 rounded-md flex flex-col items-center justify-center bg-slate-50/50 relative overflow-hidden transition-all hover:border-indigo-400 hover:bg-indigo-50/30 group/drop">
            <input
              ref={fileInputRef}
              id="check-in-photo"
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              capture="environment"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              onChange={handleFileChange}
            />
            {preview ? (
              <img src={preview} alt="Selected check-in preview" className="absolute inset-0 w-full h-full object-cover object-top" />
            ) : (
              <div className="flex flex-col items-center text-slate-400 group-hover/drop:text-indigo-500 transition-colors p-6 text-center">
                <div className="w-16 h-16 rounded-md bg-white shadow-sm flex items-center justify-center mb-4 group-hover/drop:scale-110 transition-transform duration-300">
                  <Camera size={32} aria-hidden="true" />
                </div>
                <p className="font-bold text-sm text-slate-600 mb-1">Take or upload a photo</p>
                <p className="text-xs font-medium px-4 leading-relaxed">JPEG, PNG, or WebP, up to 8 MB.</p>
              </div>
            )}
          </div>
        </div>

        {locationStatus && (
          <p role="status" className="text-xs text-indigo-600 font-bold mb-3 flex items-center gap-1">
            <MapPin size={12} aria-hidden="true" /> {locationStatus}
          </p>
        )}

        <div className="flex gap-4">
          <button
            type="button"
            onClick={handleCheckIn}
            disabled={loading || checkoutLoading}
            className={`flex-1 rounded-md py-4 font-bold text-sm flex items-center justify-center gap-2 transition-all ${loading ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-[#8b5cf6] text-white hover:bg-[#7c3aed] shadow-lg shadow-indigo-200 hover:-translate-y-0.5'}`}
          >
            {loading ? <RefreshCw size={18} className="animate-spin" aria-hidden="true" /> : <UploadCloud size={18} aria-hidden="true" />}
            {loading ? 'Submitting…' : 'Check-In'}
          </button>

          <button
            type="button"
            onClick={handleCheckOut}
            disabled={loading || checkoutLoading}
            className={`flex-1 rounded-md py-4 font-bold text-sm flex items-center justify-center gap-2 transition-all ${checkoutLoading ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-rose-50 text-rose-600 hover:bg-rose-100 border border-rose-200'}`}
          >
            {checkoutLoading ? <RefreshCw size={18} className="animate-spin" aria-hidden="true" /> : <LogOut size={18} aria-hidden="true" />}
            {checkoutLoading ? 'Submitting…' : 'Check-Out'}
          </button>
        </div>
      </div>
    </section>
  );
}
