// Story 1.6 — useIdleTimeout: client-side idle detection + absolute-lifetime
// guard for NFR-S4 (30-min idle, 30-day absolute lifetime).
//
// Supabase Auth has no native idle concept: the JWT exp clock ticks regardless
// of user input. We listen to a small, opinionated set of DOM events at the
// window level, debounce them, and arm a single wall-clock-based setTimeout
// so backgrounded tabs still expire correctly on wake. On expiry the hook
// calls `config.onExpired` (production = `() => supabase.auth.signOut()`);
// the existing AuthStateListener in src/app/providers.tsx then catches the
// resulting SIGNED_OUT event and fires the toast + redirect.
//
// Absolute 30-day lifetime is enforced both here (client-side localStorage
// guard, fail-closed) and in the Supabase Auth project config (authoritative);
// the earliest expiry wins.

import { useEffect, useRef } from "react";

import { supabase } from "@/infrastructure/supabase/client";
import { SESSION_ACTIVITY_DEBOUNCE_MS, SESSION_STARTED_AT_STORAGE_KEY } from "@/lib/constants";

import type { IdleTimeoutConfig } from "../types";

// Exact set committed by the spec. No mousemove/pointermove (too chatty —
// defeats the spirit of "inactivity"), no focus/blur/visibilitychange
// (tab switching is not user intent; wall-clock arming handles backgrounded
// tabs on wake).
const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "scroll"] as const;

// Same object for add + remove — a mismatched `capture` flag would make
// removeEventListener a silent no-op and leak listeners across mounts.
const LISTENER_OPTS: AddEventListenerOptions = { capture: true, passive: true };

export function useIdleTimeout(config: IdleTimeoutConfig): void {
  // Stable closure over the latest config so the subscribed listeners can
  // read the current onExpired without re-subscribing on every render.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  const lastActivityAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const clearIdleTimer = (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const clearDebounce = (): void => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };

    const getAbsoluteEndAt = (): number | null => {
      const raw = window.localStorage.getItem(SESSION_STARTED_AT_STORAGE_KEY);
      if (raw === null) return null;
      const startedAt = Date.parse(raw);
      if (Number.isNaN(startedAt)) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn(
            `[session] corrupt ${SESSION_STARTED_AT_STORAGE_KEY} value, ignoring: ${raw}`,
          );
        }
        return null;
      }
      return startedAt + configRef.current.absoluteLifetimeMs;
    };

    const isAbsoluteLifetimeExceeded = (): boolean => {
      const end = getAbsoluteEndAt();
      return end !== null && Date.now() >= end;
    };

    const armTimer = (): void => {
      clearIdleTimer();
      // AC 3a: the absolute-lifetime check runs on every timer arm — target
      // is the EARLIER of idle-end and absolute-end so a continuously active
      // session still expires at the 30-day boundary instead of relying on
      // the Supabase server-side refresh-token TTL as the sole enforcer.
      const idleEndAt = lastActivityAtRef.current + configRef.current.idleMs;
      const absoluteEndAt = getAbsoluteEndAt();
      const targetAt = absoluteEndAt !== null ? Math.min(idleEndAt, absoluteEndAt) : idleEndAt;
      const remaining = Math.max(0, targetAt - Date.now());
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void configRef.current.onExpired();
      }, remaining);
    };

    const handleActivity = (): void => {
      if (!activeRef.current) return;
      lastActivityAtRef.current = Date.now();
      // Cancel the pending idle timer IMMEDIATELY on every event (cheap,
      // O(1)) so an activity event 1s before expiry can't race the debounce
      // and let the old timer fire. Only the re-arming setTimeout call is
      // debounced — that keeps setTimeout churn bounded during scroll bursts.
      clearIdleTimer();
      if (debounceRef.current !== null) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (!activeRef.current) return;
        armTimer();
      }, SESSION_ACTIVITY_DEBOUNCE_MS);
    };

    const attachListeners = (): void => {
      for (const evt of ACTIVITY_EVENTS) {
        window.addEventListener(evt, handleActivity, LISTENER_OPTS);
      }
    };
    const detachListeners = (): void => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, handleActivity, LISTENER_OPTS);
      }
    };

    const startSession = (): void => {
      if (activeRef.current) return;
      activeRef.current = true;
      lastActivityAtRef.current = Date.now();
      attachListeners();
      armTimer();
    };
    const endSession = (): void => {
      activeRef.current = false;
      detachListeners();
      clearIdleTimer();
      clearDebounce();
    };

    // Initial probe. The absolute-lifetime guard runs ONLY when a session is
    // present — a stale storage key with no session would otherwise trigger
    // a phantom signOut() on every cold load.
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        if (!data.session) return;
        if (isAbsoluteLifetimeExceeded()) {
          void configRef.current.onExpired();
          return;
        }
        startSession();
      })
      .catch(() => {
        // Corrupt localStorage or Safari private-mode storage throttling —
        // the onAuthStateChange subscription below will drive state instead.
      });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;

      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session) {
        // INITIAL_SESSION fires on page load when a persisted session exists.
        // If getSession() failed (Safari private mode, storage throttling),
        // this is the only opportunity to arm the hook — treat it identically
        // to SIGNED_IN. startSession() guards against double-arming via
        // activeRef, so a successful getSession() + INITIAL_SESSION pair is safe.
        //
        // Only stamp sc_session_started_at on the FIRST sign-in: supabase-js
        // can emit SIGNED_IN on subsequent page loads (persisted-session rehydration);
        // overwriting would silently extend the 30-day absolute window.
        if (window.localStorage.getItem(SESSION_STARTED_AT_STORAGE_KEY) === null) {
          window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, new Date().toISOString());
        }
        if (isAbsoluteLifetimeExceeded()) {
          void configRef.current.onExpired();
          return;
        }
        startSession();
        return;
      }

      if (event === "SIGNED_OUT") {
        window.localStorage.removeItem(SESSION_STARTED_AT_STORAGE_KEY);
        endSession();
        return;
      }

      if (event === "TOKEN_REFRESHED") {
        const ts = new Date().toISOString();
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.debug("[session] token refreshed", { at: ts });
        }
        // Production-safe structured event; picked up by whichever log
        // pipeline the observability story wires later.
        // eslint-disable-next-line no-console
        console.info({ event: "session.token_refreshed", ts });
        return;
      }

      // USER_UPDATED / PASSWORD_RECOVERY: no-op.
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
      endSession();
    };
  }, []);
}
