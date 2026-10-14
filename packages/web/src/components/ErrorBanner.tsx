import type { JSX } from 'react';
import type { ApiClientError } from '../api/client';

interface ErrorBannerProps {
  readonly error: ApiClientError | undefined;
  readonly onDismiss: () => void;
}

/**
 * Surfaces the API's own error code alongside its message. During a flash sale
 * "sold out" and "slow down" need to look different to the person clicking.
 */
export const ErrorBanner = ({ error, onDismiss }: ErrorBannerProps): JSX.Element | null => {
  if (error === undefined) {
    return null;
  }

  return (
    <div className="banner banner--error" role="alert">
      <div>
        <strong className="banner__code">{error.code}</strong>
        <span className="banner__message">{error.message}</span>
      </div>
      <button type="button" className="button button--ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
};
