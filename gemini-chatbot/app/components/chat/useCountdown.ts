'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Whole-second countdown timer. `start(n)` (re)arms it to n seconds; `secondsLeft`
 * ticks down to 0 and stops. Drives disabled-until-elapsed Retry UI so a futile
 * immediate retry can't re-fire into an exhausted quota or an active rate limit.
 */
export function useCountdown() {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicking = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const clear = () => {
    stopTicking();
    setSecondsLeft(0);
  };

  const start = (seconds: number) => {
    stopTicking();
    const initial = Math.max(0, Math.ceil(seconds));
    setSecondsLeft(initial);
    if (initial === 0) return;
    intervalRef.current = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          stopTicking();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Clean up the interval if the consumer unmounts mid-countdown.
  useEffect(() => stopTicking, []);

  return { secondsLeft, start, clear };
}
