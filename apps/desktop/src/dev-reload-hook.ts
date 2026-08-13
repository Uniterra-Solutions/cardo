import { CATALOGS_DEV_RELOAD_MARKER } from "@pi-gui/catalogs/dev-reload-probe";
import { PI_SDK_DRIVER_DEV_RELOAD_MARKER } from "@pi-gui/pi-sdk-driver/dev-reload-probe";
import { SESSION_DRIVER_DEV_RELOAD_MARKER } from "@pi-gui/session-driver/dev-reload-probe";
import { RENDERER_DEV_RELOAD_MARKER } from "./dev-reload-probe";

declare global {
  interface Window {
    __piDevReloadRenderer?: Record<string, string>;
    __piDevReloadHost?: Record<string, string>;
  }
}

if (import.meta.env.VITE_PI_APP_DEV_RELOAD_MARKERS === "1") {
  window.__piDevReloadRenderer = {
    renderer: RENDERER_DEV_RELOAD_MARKER,
    "session-driver": SESSION_DRIVER_DEV_RELOAD_MARKER,
    "pi-sdk-driver": PI_SDK_DRIVER_DEV_RELOAD_MARKER,
    catalogs: CATALOGS_DEV_RELOAD_MARKER,
  };
}

export {};
