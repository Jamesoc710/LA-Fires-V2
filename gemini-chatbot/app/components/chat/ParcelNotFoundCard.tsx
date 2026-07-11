// FIX #9: Error card for invalid APN or data retrieval failures
function ParcelNotFoundCard({ apn, message }: { apn?: string; message?: string }) {
  return (
    <div className="rounded-2xl bg-red-950/50 border border-red-500/30 text-red-300 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div>
          <h3 className="text-base font-semibold mb-1">Could Not Retrieve Parcel Data</h3>
          <p className="text-sm mb-2">
            {message || `Unable to find data for ${apn ? `APN ${apn}` : 'the provided number'} in LA County records.`}
          </p>
          <div className="text-sm space-y-1">
            <p className="font-medium">Please verify:</p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li>APNs are 10 digits (e.g., 5843-004-015)</li>
              <li>The number matches your property tax bill</li>
              <li>The parcel is located in LA County</li>
            </ul>
          </div>
          <div className="mt-3 flex gap-3">
            <a
              href="https://portal.assessor.lacounty.gov/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center text-sm font-medium text-amber-300 hover:text-amber-200 hover:underline"
            >
              Look up your APN ↗
            </a>
            <span className="text-stone-600">|</span>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center text-sm font-medium text-amber-300 hover:text-amber-200 hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ParcelNotFoundCard;
