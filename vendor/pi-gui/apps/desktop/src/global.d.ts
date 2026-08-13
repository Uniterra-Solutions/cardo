import type { PiDesktopApi } from "./ipc";

export {};

declare global {
  interface Window {
    piApp?: PiDesktopApi;
  }
}
