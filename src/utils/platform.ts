// Synchronous Linux check — used to skip looping animations that pin the CPU
// on Linux WebView2/WebKitGTK. navigator.platform is deprecated but reliable
// inside the Tauri WebView; userAgentData.platform is the modern equivalent.
export const IS_LINUX: boolean = (() => {
  try {
    const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    const platform = (ua?.platform || navigator.platform || '').toLowerCase();
    return platform.includes('linux');
  } catch {
    return false;
  }
})();

// Synchronous Windows check — the "add app" file picker only offers
// executables there (.exe/.lnk/.bat); elsewhere any file is pickable.
export const IS_WINDOWS: boolean = (() => {
  try {
    const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    const platform = (ua?.platform || navigator.platform || '').toLowerCase();
    return platform.includes('win');
  } catch {
    return false;
  }
})();

// Synchronous macOS check — the frameless title bar must decide on the first
// paint whether window controls sit on the left (native traffic lights, macOS)
// or the right (Windows/Linux), and CSS must know whether to drop the custom
// rounded shell (macOS uses native decorations, so the OS owns the corners).
export const IS_MACOS: boolean = (() => {
  try {
    const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    const platform = (ua?.platform || navigator.platform || '').toLowerCase();
    return platform.includes('mac');
  } catch {
    return false;
  }
})();
