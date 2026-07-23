import React, { useEffect, useRef, useState } from "react";

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;

let scriptLoadingPromise = null;
function loadGoogleMapsScript() {
  if (!GOOGLE_MAPS_KEY) return Promise.reject(new Error("No Google Maps API key configured"));
  if (window.google?.maps?.places) return Promise.resolve();
  if (scriptLoadingPromise) return scriptLoadingPromise;

  scriptLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
  return scriptLoadingPromise;
}

// Same look/behavior as the plain Field component, but upgrades to Google
// Places autocomplete when VITE_GOOGLE_MAPS_KEY is set. Falls back to a
// normal text input (still fully usable) if the key is missing or the
// script fails to load — so the app never breaks over this.
export function AddressField({ icon, placeholder, value, onChange, onPlaceSelected, theme: T }) {
  const inputRef = useRef(null);
  const autocompleteRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMapsScript()
      .then(() => {
        if (cancelled || !inputRef.current) return;
        autocompleteRef.current = new window.google.maps.places.Autocomplete(inputRef.current, {
          fields: ["formatted_address", "geometry"],
        });
        autocompleteRef.current.addListener("place_changed", () => {
          const place = autocompleteRef.current.getPlace();
          if (place?.formatted_address) onChange(place.formatted_address);
          const loc = place?.geometry?.location;
          if (loc && onPlaceSelected) {
            onPlaceSelected({ lat: loc.lat(), lng: loc.lng() });
          }
        });
        setReady(true);
      })
      .catch(() => {
        // no key or failed to load — plain text input still works fine
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex items-center gap-2 border rounded-sm px-3 py-2.5" style={{ borderColor: T.border }}>
      {icon && <span style={{ color: T.mutedDark }}>{icon}</span>}
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          if (onPlaceSelected) onPlaceSelected(null); // typed by hand — coords are stale, clear them
        }}
        className="w-full bg-transparent text-sm focus:outline-none"
        style={{ color: T.ivory }}
        autoComplete="off"
      />
    </div>
  );
}
