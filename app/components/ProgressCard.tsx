'use client';

interface ProgressCardProps {
  progress: any;
  onCancel: () => void;
}

export default function ProgressCard({ progress, onCancel }: ProgressCardProps) {
  if (!progress || progress.status !== 'running') return null;

  const stageLabel = (p: any) => {
    if (!p) return '';
    switch (p.stage) {
      case 'navigating': return 'Navigating to store...';
      case 'scanning_categories': return 'Scanning categories...';
      case 'scanning_items': return `Scanning items (${p.sectionsProcessed || 0}/${p.sectionsTotal || 0} sections, ${p.itemsDiscovered || 0} items)...`;
      case 'items_collected': return `Items collected: ${p.total || 0}`;
      case 'fetching_details': return `Fetching details (${p.processed || 0}/${p.total || 0})`;
      case 'retrying_details': return `Retrying failed items (round ${p.retryRound || 1}, pending ${p.retryPending || 0})`;
      case 'completed': return 'Completed';
      default: return p.message || 'Working...';
    }
  };

  const isRetry = progress.stage === 'retrying_details';
  const effectiveTotal = isRetry ? (progress.retryPending || progress.total || 0) : (progress.total || 0);
  const processed = progress.processed || 0;
  const percentage = effectiveTotal ? Math.min(100, Math.round((processed / effectiveTotal) * 100)) : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Processing Menu</h3>
            <p className="text-xs text-gray-500">{stageLabel(progress)}</p>
          </div>
        </div>
                 <button
           onClick={onCancel}
           className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors cursor-pointer"
         >
          Cancel
        </button>
      </div>

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-gray-600">
          <span>Progress</span>
          <span>{percentage}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div 
            className="bg-gradient-to-r from-blue-500 to-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
        
        {/* Detailed Stats */}
        {(progress.stage === 'fetching_details' || progress.stage === 'retrying_details') && (
          <div className="flex justify-between text-xs text-gray-500 pt-2">
            <span>{processed}/{effectiveTotal} processed</span>
            <div className="flex space-x-4">
              <span className="text-green-600">✓ {(progress.success || 0)} ok</span>
              <span className="text-red-600">✗ {(progress.fail || 0)} fail</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
