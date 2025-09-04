'use client';

import { useState, useRef, useEffect } from 'react';
import LZString from 'lz-string';
import MenuDisplay from './components/MenuDisplay';
import LoadingSpinner from './components/LoadingSpinner';
import Navbar from './components/Navbar';
import GoogleDriveCard from './components/GoogleDriveCard';
import ProgressCard from './components/ProgressCard';

export default function Home() {
  const [inputUrl, setInputUrl] = useState('');
  const [menuData, setMenuData] = useState(null);
  const [rawData, setRawData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState<any | null>(null);
  const [progress, setProgress] = useState<any | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportResult, setExportResult] = useState<any | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [pickerConfig, setPickerConfig] = useState<{ clientId: string; developerKey: string; appId?: string } | null>(null);
  const [destinationFolder, setDestinationFolder] = useState<{ id: string; name: string } | null>(null);
  const pickerOpenRef = useRef<boolean>(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [currentFolder, setCurrentFolder] = useState<{ id: string; name: string } | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([]);
  const [folderItems, setFolderItems] = useState<Array<{ id: string; name: string }>>([]);
  const jobIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<any>(null);
  const stopRef = useRef<boolean>(false);

  const RAW_DATA_STORAGE_KEY = 'menai.rawData';
  const MENU_DATA_STORAGE_KEY = 'menai.menuData';

  // Load persisted raw data on mount (decompress)
  useEffect(() => {
    try {
      const stored = typeof window !== 'undefined' ? localStorage.getItem(RAW_DATA_STORAGE_KEY) : null;
      if (stored) {
        const decompressed = LZString.decompressFromUTF16(stored) || stored;
        const parsed = JSON.parse(decompressed);
        setRawData(parsed);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check Google status and picker config
  useEffect(() => {
    (async () => {
      try {
        const s = await fetch('/api/google/oauth/status', { cache: 'no-store' });
        const j = await s.json();
        setGoogleConnected(Boolean(j?.connected));
      } catch {}
      try {
        const r = await fetch('/api/google/picker-config', { cache: 'no-store' });
        if (r.ok) setPickerConfig(await r.json());
      } catch {}
    })();
  }, []);

  // Persist raw data to localStorage (compress) or clear when null
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      if (rawData) {
        const compact = {
          jobId: (rawData as any)?.jobId ?? null,
          scraped: (rawData as any)?.scraped ?? null,
          failedItems: Array.isArray((rawData as any)?.failedItems) ? (rawData as any).failedItems : [],
        };
        const json = JSON.stringify(compact);
        const compressed = LZString.compressToUTF16(json);
        localStorage.setItem(RAW_DATA_STORAGE_KEY, compressed);
      } else {
        localStorage.removeItem(RAW_DATA_STORAGE_KEY);
      }
    } catch (e) {
      try { console.warn('Failed to persist rawData:', e); } catch {}
    }
  }, [rawData]);

  // Load persisted menu data on mount (decompress)
  useEffect(() => {
    try {
      const stored = typeof window !== 'undefined' ? localStorage.getItem(MENU_DATA_STORAGE_KEY) : null;
      if (stored) {
        const decompressed = LZString.decompressFromUTF16(stored) || stored;
        const parsed = JSON.parse(decompressed);
        setMenuData(parsed);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist menu data to localStorage (compress) or clear when null
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      if (menuData) {
        const json = JSON.stringify(menuData);
        const compressed = LZString.compressToUTF16(json);
        localStorage.setItem(MENU_DATA_STORAGE_KEY, compressed);
      } else {
        localStorage.removeItem(MENU_DATA_STORAGE_KEY);
      }
    } catch (e) {
      try { console.warn('Failed to persist menuData:', e); } catch {}
    }
  }, [menuData]);

  const normalizeUrl = (input: string): string | null => {
    try { if (!input.startsWith('http')) return null; const u = new URL(input); return u.toString(); } catch { return null; }
  };

  const cleanupProgress = async (jobId: string | null) => {
    if (!jobId) return;
    try { await fetch(`/api/scrape-menu/progress?id=${jobId}&cleanup=true`); } catch {}
  };

  const requestCancel = async () => {
    if (!jobIdRef.current) return;
    try {
      await fetch('/api/scrape-menu/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: jobIdRef.current, action: 'cancel' }) });
    } catch {}
    // Optimistically mark cancelled in UI and stop polling
    setProgress((p: any) => p ? { ...p, status: 'cancelled', stage: 'cancelled', message: 'cancelled' } : p);
    stopRef.current = true; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); pollTimerRef.current = null;
  };

  const exportToSheets = async () => {
    if (!rawData?.scraped) return;
    if (!googleConnected) { setExportError('Connect Google first'); return; }
    setExportError('');
    setExportResult(null);
    setExportLoading(true);
    try {
      const payload = { jobId: rawData.jobId || 'unknown', scraped: rawData.scraped, destinationFolderId: destinationFolder?.id || null };
      const r = await fetch('/api/export-to-sheets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.error || `Failed to export (${r.status})`);
      setExportResult({ id: out.spreadsheetId, url: out.spreadsheetUrl });
    } catch (e: any) {
      setExportError(e?.message || 'Failed to export');
    } finally {
      setExportLoading(false);
    }
  };

  const connectGoogle = () => {
    window.location.href = '/api/google/oauth/start';
  };

  const disconnectGoogle = async () => {
    try { await fetch('/api/google/logout', { method: 'POST' }); setGoogleConnected(false); setDestinationFolder(null); } catch {}
  };

  const listFolderChildren = async (folderId: string, folderName: string) => {
    setFolderLoading(true); setFolderError('');
    try {
      const tokenResp = await fetch('/api/google/access-token', { cache: 'no-store' });
      if (!tokenResp.ok) throw new Error('Not connected');
      const { accessToken } = await tokenResp.json();
      let pageToken: string | undefined = undefined;
      const items: Array<{ id: string; name: string }> = [];
      do {
        const params = new URLSearchParams({
          q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id,name),nextPageToken',
          pageSize: '100',
          includeItemsFromAllDrives: 'true',
          supportsAllDrives: 'true',
          spaces: 'drive',
          orderBy: 'name_natural',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const j = await r.json();
        if (j && j.error) throw new Error(j.error?.message || 'Drive error');
        if (Array.isArray(j.files)) {
          for (const f of j.files) items.push({ id: f.id, name: f.name });
        }
        pageToken = j.nextPageToken || undefined;
      } while (pageToken);
      setCurrentFolder({ id: folderId, name: folderName });
      setFolderItems(items.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: any) {
      setFolderError(e?.message || 'Failed to list folder');
    } finally {
      setFolderLoading(false);
    }
  };

  const openFolderModal = async () => {
    if (!googleConnected) { setExportError('Connect Google first'); return; }
    setFolderModalOpen(true);
    setBreadcrumbs([]);
    await listFolderChildren('root', 'My Drive');
  };

  const goIntoFolder = async (folder: { id: string; name: string }) => {
    if (currentFolder) setBreadcrumbs((b) => [...b, currentFolder]);
    await listFolderChildren(folder.id, folder.name);
  };

  const goBackFolder = async () => {
    if (breadcrumbs.length === 0) { setFolderModalOpen(false); return; }
    const next = [...breadcrumbs];
    const prev = next.pop()!;
    setBreadcrumbs(next);
    await listFolderChildren(prev.id, prev.name);
  };

  const clearStoredData = () => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(RAW_DATA_STORAGE_KEY);
        localStorage.removeItem(MENU_DATA_STORAGE_KEY);
      }
    } catch {}
    setRawData(null);
    setMenuData(null);
    setDebugInfo(null);
  };

  const fetchMenu = async () => {
    if (!inputUrl.trim()) { setError('Please enter an Uber Eats URL'); return; }

    setLoading(true); setError(''); setMenuData(null); setRawData(null); setExportResult(null); setExportError(''); setProgress(null);
    stopRef.current = true; if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }

    try {
      const normalized = normalizeUrl(inputUrl.trim()); if (!normalized) throw new Error('Invalid Uber Eats URL');
      const jobId = crypto.randomUUID(); jobIdRef.current = jobId; stopRef.current = false;

      const poll = async () => {
        if (stopRef.current || !jobIdRef.current) return;
        try {
          const r = await fetch(`/api/scrape-menu/progress?id=${jobIdRef.current}`);
          if (r.ok) {
            const p = await r.json(); setProgress(p);
            if (!stopRef.current && p?.status === 'running') pollTimerRef.current = setTimeout(poll, 1000);
          } else if (r.status === 404) {
            if (!stopRef.current) pollTimerRef.current = setTimeout(poll, 400);
          } else {
            stopRef.current = true; jobIdRef.current = null; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); pollTimerRef.current = null;
          }
        } catch {
          stopRef.current = true; jobIdRef.current = null; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); pollTimerRef.current = null;
        }
      }; poll();

      const response = await fetch(`/api/scrape-menu`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: normalized, fast: false, maxItems: 1000, timeoutMs: 120000, jobId }) });

      let data: any = null; try { data = await response.json(); } catch { data = null; }
      if (!response.ok) { setDebugInfo(data?.debug || { status: response.status }); setRawData(data?.raw || null); throw new Error(data?.error || `Failed to fetch menu data (${response.status})`); }

      const raw = (data && data.raw) ? data.raw : data; const normalizedPayload = data && data.normalized ? data.normalized : null;
      setRawData(raw); setDebugInfo(data?.debug || null); setMenuData(normalizedPayload);
      try {
        if (typeof window !== 'undefined' && normalizedPayload) {
          const json = JSON.stringify(normalizedPayload);
          const compressed = LZString.compressToUTF16(json);
          localStorage.setItem(MENU_DATA_STORAGE_KEY, compressed);
        }
      } catch (e) { try { console.warn('Immediate persist of menuData failed:', e); } catch {} }
      setProgress((p: any) => (p?.status === 'cancelled' ? p : { ...(p || {}), status: 'completed', stage: 'completed', message: 'completed' }));

      stopRef.current = true; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); pollTimerRef.current = null; await cleanupProgress(jobId); jobIdRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setProgress((p: any) => (p?.status === 'cancelled' ? p : { ...(p || {}), status: 'error', stage: 'error', message: 'error' }));
    } finally {
      stopRef.current = true; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); pollTimerRef.current = null; if (jobIdRef.current) await cleanupProgress(jobIdRef.current); jobIdRef.current = null; setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); setDebugInfo(null); fetchMenu(); };

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar 
        googleConnected={googleConnected}
        onConnectGoogle={connectGoogle}
        onDisconnectGoogle={disconnectGoogle}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Extract Menu Data from Any Restaurant
          </h1>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Paste a restaurant URL and get structured menu data instantly. Export to Google Sheets for analysis and sharing.
          </p>
        </div>

        {/* Main Input Section */}
        <div className="max-w-4xl mx-auto mb-8">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="restaurant-url" className="block text-sm font-medium text-gray-700 mb-2">
                  Restaurant URL
                </label>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <input 
                      id="restaurant-url"
                      type="text" 
                      value={inputUrl} 
                      onChange={(e) => setInputUrl(e.target.value)} 
                      placeholder="https://www.ubereats.com/store/restaurant-name/..." 
                      className="w-full px-4 py-4 text-gray-900 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none text-lg"
                    />
                  </div>
                  <button 
                    type="submit" 
                    disabled={loading} 
                    className="px-8 py-4 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-xl hover:from-green-700 hover:to-emerald-700 focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-lg shadow-lg cursor-pointer"
                  >
                    {loading ? (
                      <div className="flex items-center space-x-2">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        <span>Processing...</span>
                      </div>
                    ) : (
                      'Extract Menu'
                    )}
                  </button>
                </div>
              </div>
              
              <div className="text-sm text-gray-500">
                <span className="font-medium">Example:</span>{' '}
                <p
                  className="underline"
                >
                  https://www.ubereats.com/store/palenque-homemade-colombian-food/WFoN8F22TNGmk4AjVtm8NQ
                </p>
              </div>
            </form>
          </div>
        </div>

        {/* Google Drive Integration */}
        <div className="max-w-4xl mx-auto mb-8">
          <GoogleDriveCard
            googleConnected={googleConnected}
            destinationFolder={destinationFolder}
            onConnectGoogle={connectGoogle}
            onDisconnectGoogle={disconnectGoogle}
            onOpenFolderModal={openFolderModal}
            onExportToSheets={exportToSheets}
            exportLoading={exportLoading}
            exportError={exportError}
            exportResult={exportResult}
            hasData={Boolean(rawData?.scraped && !loading && progress?.status !== 'running')}
          />
        </div>

        {/* Progress Card */}
        <div className="max-w-4xl mx-auto mb-8">
          <ProgressCard 
            progress={progress}
            onCancel={requestCancel}
          />
        </div>

        {/* Error Display */}
        {error && (
          <div className="max-w-4xl mx-auto mb-8">
            <div className="bg-red-50 border border-red-200 rounded-xl p-6">
              <div className="flex">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3">
                  <h3 className="text-lg font-medium text-red-800">Error</h3>
                  <div className="mt-2 text-red-700">
                    <p>{error}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading Spinner */}
        {loading && (
          <div className="max-w-4xl mx-auto mb-8">
            <LoadingSpinner />
          </div>
        )}

        {/* Menu Display */}
        {menuData && (
          <div className="mb-8">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-gray-900">Menu Data</h2>
              <button 
                onClick={clearStoredData} 
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors cursor-pointer"
              >
                Clear Data
              </button>
            </div>
            <MenuDisplay menuData={menuData} />
          </div>
        )}

        {/* Failed Items */}
        {rawData?.failedItems?.length > 0 && (
          <div className="max-w-4xl mx-auto mb-8">
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-yellow-800 mb-4">
                Failed Items ({rawData.failedItems.length})
              </h3>
              <ul className="space-y-2">
                {rawData.failedItems.map((f: any, idx: number) => (
                  <li key={`${f.id || idx}`} className="flex items-center justify-between p-3 bg-white rounded-lg border border-yellow-200">
                    <span className="font-medium text-gray-800">{f.title || f.id || 'Unknown item'}</span>
                    {f.href && (
                      <a
                        href={f.href?.startsWith('http') ? f.href : `https://www.ubereats.com${f.href || ''}`}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1 text-sm bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors"
                      >
                        View Item
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Raw Data Debug */}
        {rawData && (
          <div className="max-w-4xl mx-auto mb-8">
            <details className="bg-white border border-gray-200 rounded-xl">
              <summary className="cursor-pointer select-none px-6 py-4 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
                View Raw JSON Data
              </summary>
              <div className="max-h-[480px] text-gray-700 overflow-auto p-6 text-xs bg-gray-50 border-t border-gray-200">
                <pre className="whitespace-pre-wrap break-all">{JSON.stringify(rawData, null, 2)}</pre>
              </div>
            </details>
          </div>
        )}

        {/* Menu JSON Debug */}
        {menuData && (
          <div className="max-w-4xl mx-auto mb-8">
            <details className="bg-white border border-gray-200 rounded-xl">
              <summary className="cursor-pointer select-none px-6 py-4 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
                View Menu JSON Data
              </summary>
              <div className="max-h-[480px] text-gray-700 overflow-auto p-6 text-xs bg-gray-50 border-t border-gray-200">
                <pre className="whitespace-pre-wrap break-all">{JSON.stringify(menuData, null, 2)}</pre>
              </div>
            </details>
          </div>
        )}

        {/* Empty State */}
        {!menuData && !loading && !error && (
          <div className="text-center py-16">
            <div className="w-24 h-24 mx-auto mb-6 bg-gray-100 rounded-full flex items-center justify-center">
              <svg className="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">Ready to Extract Menu Data</h3>
            <p className="text-gray-600 max-w-md mx-auto">
              Enter a restaurant URL above to start extracting structured menu data that you can export to Google Sheets.
            </p>
          </div>
        )}
      </main>

      {/* Folder Selection Modal */}
      {folderModalOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setFolderModalOpen(false)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-xl bg-white rounded-xl shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900">Choose Destination Folder</h3>
                <button 
                  onClick={() => setFolderModalOpen(false)} 
                  className="p-2 text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="px-6 py-4">
                <div className="flex items-center gap-2 text-sm text-gray-600 mb-4">
                  <button 
                    onClick={goBackFolder} 
                    className="px-3 py-1.5 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    ← Back
                  </button>
                  <div className="truncate">
                    {[...breadcrumbs, currentFolder].filter(Boolean).map((b: any, i: number) => (
                      <span key={b.id || i} className="mr-1">
                        {b.name}{i < breadcrumbs.length ? ' /' : ''}
                      </span>
                    ))}
                  </div>
                </div>
                {folderError && (
                  <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-sm text-red-700">{folderError}</p>
                  </div>
                )}
                <div className="max-h-72 overflow-auto border border-gray-200 rounded-lg">
                  {folderLoading ? (
                    <div className="p-6 text-center text-gray-600">
                      <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin mx-auto mb-2"></div>
                      Loading folders...
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-200">
                      {folderItems.map((f) => (
                        <li key={f.id} className="px-4 py-3 hover:bg-gray-50 flex items-center justify-between">
                          <button 
                            onClick={() => goIntoFolder(f)} 
                            className="text-sm text-gray-800 hover:text-gray-900 text-left truncate flex items-center space-x-2"
                          >
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5a2 2 0 012-2h4a2 2 0 012 2v2H8V5z" />
                            </svg>
                            <span>{f.name}</span>
                          </button>
                          <button 
                            onClick={() => { setDestinationFolder(f); setFolderModalOpen(false); }} 
                            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                          >
                            Select
                          </button>
                        </li>
                      ))}
                      {folderItems.length === 0 && (
                        <li className="px-4 py-8 text-sm text-gray-500 text-center">
                          No subfolders found
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              </div>
              <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  Selected: {destinationFolder ? (
                    <span className="font-medium text-gray-900">{destinationFolder.name}</span>
                  ) : (
                    <span className="text-gray-500">My Drive (root)</span>
                  )}
                </div>
                <button 
                  onClick={() => setFolderModalOpen(false)} 
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}